# 基於 OpenStack 的 Kubernetes BGP + DSR L4 Load Balancer 模擬實驗室

**（單一 ASN、全節點 iBGP、真實資料中心路由模型 — v2,含 OpenStack 可行性修正；對外服務入口章節已被 v3 現況修正取代,見 §0.1)**

---

## 0. v2 修訂說明(先讀這段)

這份文件是 v1 的修正版。v1 有兩個地方在標準 OpenStack 租戶帳號上**做不到**,v2 已經改用可實際落地的做法取代,並保留原本的教學目的:

| v1 的假設 | 問題 | v2 的做法 |
| --- | --- | --- |
| OpenStack Router 可以只做一條靜態路由 `1.2.3.4/32 → TOR`,讓 1.2.3.4 變成全球可路由的公網位址 | Neutron Floating IP 是 1:1 NAT,不是「租一個公網 prefix 讓你自己配」。一般租戶無法自行注入一條會被上游網路接受的公網靜態路由,這需要雲平台營運商開放 `neutron-dynamic-routing`(BGP)或 routed provider network,一般社群雲(含本專案使用的 `cloudnative.tw`)通常不提供 | 用**一個 Floating IP 綁在 TOR 身上**當公網入口(標準 Neutron 功能,任何 OpenStack 都支援)。這是全架構**唯一**的 NAT 邊界,從 TOR 再往內(TOR → L4LB → Pod → 回 TOR)仍然是完全真實、無 NAT 的 iBGP / ECMP / DSR 行為 |
| 所有節點與 TOR 在同一個 OpenStack L2 網段,靠「大家都乖乖照 BGP 路由表走」來模擬 TOR 是唯一 L3 hop | 沒說清楚要怎麼**強制**不讓節點抄 L2 捷徑互連 | 保留單一扁平 `k8s-net`(實作簡單、資源數量少),但**新增規定**:TOR 的 iBGP 設定必須開 `next-hop-self`。這樣所有節點學到的路由 next-hop 永遠是 TOR,即使實體上在同一段 L2,節點也沒有理由直接找對方 |
| 節點靠 OpenStack Router 的預設閘道上網、裝套件 | 這台 Router 同時也是資料平面的閘道,會把所有節點流量預設 SNAT,直接打破「Pod 回應封包 Source IP = Pod IP」的 DSR 前提 | 新增一個獨立的 **management network**(out-of-band,類比真實機房的管理網),只負責一般上網 / SSH,與資料平面完全分離。資料平面(`k8s-net`)不掛任何 Neutron Router |

以下章節已經是**修正後的完整設計**,不再是逐條 diff。

---

## 0.1 v3 現況修正說明(2026-07-30,先讀這段再看下面章節)

v2 定案之後,實作又往前演進了一段,其中**對外服務入口**這一塊已經整個被
取代,不是本文件原本描述的樣子。這裡誠實標記哪些還是現況、哪些已經是
歷史設計,下面各章節對應段落也各自加了對照:

| v2 說的(§2、§4.3、§6.2、§6.4、§7、§8) | 現況 | 權威來源 |
| --- | --- | --- |
| Floating IP 綁在 TOR,是對外服務入口 | Floating IP 改綁在 **bastion**,只做 SSH/管理入口,不承載服務流量 | `main.tf` 的 `bastion_fip`;`docs/packet-flows.html` |
| TOR 本機 DNAT:mgmt IP → 內部 Service VIP | **沒有實作**,全 repo 找不到對應的 iptables/nft 規則 | 見下方 §6.2 附註 |
| L4LB 節點用 IPVS-DR 宣告 Service VIP、對 Pod 做 DSR,是對外流量的分流機制 | 這條 Terraform 分支(`bgp_role = "l4lb"`)目前**沒有任何 VM 在用**,`terraform.tfvars` 裡 `l4-0001`/`l4-0002` 的 `bgp_role` 都是 `"peer"`,程式邏輯留著但是 dormant,不影響現在的拓樸 | `docs/l4lb-history.html`(完整的 DSR 驗證過程與教訓)、`docs/infrastructure.html` |
| 對外流量走 TOR → L4LB(ECMP)→ Pod(DSR) | 實際是 **Cloudflare Tunnel → cloudflared(叢集內 pod)→ istio-ingressgateway(ClusterIP)**,完全不經過 Floating IP/TOR/L4LB | `docs/network-architecture.html`、`docs/packet-flows.html` |

**為什麼不乾脆整份改寫或刪掉**:第 3~6.1、6.3 節(ASN/iBGP/`next-hop-self`/
mgmt-net 分離/一般節點的網路模型/OpenStack 限制)描述的是**資料平面**設計,
這部分完全沒有變,現在仍然是真實運作中的設計,`ansible/roles/kubelet` 的
程式碼註解也直接引用這份文件——不是歷史文件,是現行文件。只有「服務流量
怎麼從外部世界進來」這一段(§2、§4.3 對 Floating IP 角色的描述、§6.2、§6.4、
§7、§8)被 Cloudflare Tunnel 取代了,下面對應章節個別標記,不動其餘章節。

DSR/L4LB 這套機制被留著(沒有從程式碼刪掉)是刻意的:它證明了「iBGP fabric
真的能做出 ECMP」「`port_security_enabled` 必須整段關閉」這兩個結論,而這兩個
結論**至今仍然支撐著現在的架構**(Cilium native routing 一樣靠 iBGP ECMP、
fabric port 一樣整段關閉 port security)——完整的驗證過程、為什麼這樣做,
見 `docs/l4lb-history.html`,不在這裡重複。

---

## 1. Lab 目的與設計動機

本實驗室的目標,是在 **OpenStack 虛擬化平台** 上,盡可能完整模擬 **On-Premise / Bare-metal Kubernetes** 中常見的網路架構:

* **BGP-to-the-Host**
* **資料中心 TOR 作為資料平面的唯一入口**
* **Service VIP 由節點宣告,而非平台指派**
* **DSR（Direct Server Return）資料路徑**
* **Pod CIDR 為可被整個 Cluster Network 直接路由的真實網段**

此 Lab 刻意避開「雲平台捷徑」,但**保留一個誠實的例外**:對外的那一個 Floating IP,是 OpenStack 標準 NAT 機制,不是資料中心真實的 BGP 公告。這個例外在下面章節會清楚標示邊界,不會被含糊帶過。

---

## 2. 對外行為（External View）

> **現況(v3)**:這整節描述的「Floating IP 前置」對外服務模型已經被
> Cloudflare Tunnel 取代,見上方 §0.1。Floating IP 現在只用來 SSH 進
> bastion,不是服務流量的入口。這節保留是因為它解釋了「為什麼一開始選擇
> Floating-IP-fronted 這個方案」的判斷過程,現在的判斷已經不同,但推理
> 方式本身還有參考價值。

### 2.1 對外服務模型(已修正,且已被 Cloudflare Tunnel 進一步取代,見上方 §0.1)

* 本 Lab 透過 **一個 OpenStack Floating IP** 對外提供服務入口。
* DNS 記錄指向這個 Floating IP:

```
service.example.com → <Floating IP>
```

👉 世界上任何一台電腦,只要能連上這個 Floating IP,就能存取此服務——**但這個 IP 是 Neutron NAT 進來的**,不是「1.2.3.4 這個 prefix 被路由進 TOR」。

### 2.2 如果真的需要「無 NAT 的公網 VIP」

這需要雲平台營運商層級的支援(例如 Neutron `neutron-dynamic-routing` 擴充讓租戶用 BGP 對外宣告 prefix,或是營運商直接把一段 routed provider network 委派給你的專案)。這不是 Terraform 或租戶自己能設定出來的東西。若未來要做,第一步是去問清楚 `cloudnative.tw`(或任何你使用的雲)是否有對租戶開放這類機制,可用 `openstack extension list` 檢查是否有 `bgp` / `dynamic-routing` 相關擴充。在確認之前,本設計一律以「Floating IP 前置」為預設方案。

---

## 3. 核心設計原則（v2 定案）

| 原則 | 說明 |
| --- | --- |
| 單一 ASN | TOR 與所有 K8s 節點屬於同一 AS |
| 純 iBGP | 不引入 eBGP,不模擬 ISP |
| next-hop-self(新增) | TOR 對所有 iBGP peer 一律設定 next-hop-self,確保節點間不會繞過 TOR 直連,即使實體上在同一 L2 網段 |
| VIP 不屬於 OpenStack | Service IP(內部代表位址)不綁定任何 Floating IP、不由 Neutron 指派 |
| DSR 資料路徑 | TOR 之後(TOR→L4LB→Pod→回TOR)的回程流量不經過 L4LB,也不經過任何 NAT |
| 唯一 NAT 邊界(新增) | 整個架構只有一處 NAT:Neutron Floating IP → TOR 的 mgmt-net 位址,以及 TOR 上一條對應的本機 DNAT 規則。此邊界之外(TOR 往內)全部是真實路由 |
| Pod CIDR 可全網路由 | 172.16.x.x 在整個 Cluster Network 直通 |
| 資料平面與管理平面分離(新增) | `k8s-net`(資料平面)不掛 Neutron Router;所有 VM 另外接一張 `mgmt-net` 負責上網與 SSH,兩者互不干擾 |
| TOR 單點 | 本 Lab 僅一台 TOR,簡化但不影響核心概念 |

---

## 4. 網路資源設計(新增章節)

本 Lab 在 OpenStack 上會建立**兩個獨立的 network**,角色完全不同,不可混用:

### 4.1 `k8s-net`(資料平面 / Fabric)

* CIDR:`10.10.0.0/24`(沿用現有設計)
* **不掛任何 `openstack_networking_router_v2`**——這是與 v1 最大的差異。這個網路對 Neutron 而言只是一段普通的 L2 網段,路由完全交給 TOR(一台會轉發封包的 VM),不是交給 Neutron L3 agent。
* Subnet 的 `gateway_ip` 設為 **TOR 在這個網段的位址**(沿用現有的 `k8s-router-vm` = `10.10.0.10`),讓 DHCP 發出去的預設閘道直接指向 TOR,而不是 Neutron Router。
* IPv6(`fd00:1::/64`)為選用:如果只是要讓 FRR 用 IPv6 link-local(`fe80::/10`)建 BGP session,其實**不需要**這個 global IPv6 subnet——link-local 位址是 kernel 自動產生的,和 Neutron 有沒有配 IPv6 subnet 無關。如果不打算真的測 IPv6 pod networking,可以拿掉這段簡化維運;如果要保留,行為不受本次修正影響。

### 4.2 `mgmt-net`(管理平面 / Out-of-Band,新增)

* CIDR:建議 `192.168.200.0/24`(避免與 `10.10.0.0/24`、`fd00:1::/64` 衝突)
* 掛一個 `openstack_networking_router_v2`,`external_network_id` 指向 `var.external_network_name`,**`enable_snat = true`**(這裡就是要讓大家能上網裝套件,SNAT 開著是正確行為,不是缺陷)。
* **每一台 VM(包含 TOR)都額外接一張 NIC 到這個網路**,對應真實資料中心的 out-of-band 管理網。
* 節點的 **default route（0.0.0.0/0）應該指向 `mgmt-net`**,而不是任何 BGP 學來的路由;Pod CIDR、Service VIP 這些具體前綴則仍然透過 BGP、經 `k8s-net` 走向 TOR。因為 BGP 路由永遠比 default route 更精確,兩者不會衝突。這也呼應原設計「❌ 不應宣告 Default Route」的原則——default route 本來就不該從 BGP 來。

### 4.3 對外入口(Floating IP)——**現況(v3)：Floating IP 已改綁 bastion,只做 SSH/ops,不再是服務入口,見上方 §0.1**

以下描述的是 v2 定案時的設計,保留是因為它解釋了 NAT 邊界這個概念本身:

* 只配 **一個** Floating IP,綁定到 TOR 的 `mgmt-net` 位址上。
* 這個 Floating IP 同時扮演兩個角色:
  1. **管理 SSH 入口**:`ssh ubuntu@<Floating IP>`,其餘節點透過 TOR 當 jump host,用 `k8s-net` 的私有 IP 連線。
  2. **服務入口**:外部流量打到這個 Floating IP → Neutron NAT 到 TOR 的 `mgmt-net` 固定 IP → TOR 本機用 `iptables`/`nftables` 的 `PREROUTING` DNAT 規則,把目的位址改寫成內部的 Service VIP(例如 `172.31.255.1`)→ 之後完全交給 FRR 學來的 ECMP 路由表處理,跟 v1 描述的行為完全一致。
* 這是全架構**唯一**出現位址轉換的地方,而且只發生一次(進站時)。回程封包沿著 BGP/ECMP 學到的路徑,原封不動地經 TOR 送回同一個 conntrack 連線,Neutron 再把來源位址換回 Floating IP——這段行為 Neutron/Netfilter 標準 NAT 語意就能正確處理,不需要額外機制。

---

## 5. ASN 與 BGP 設計

### 5.1 ASN 規劃(不變)

* **TOR VM**
* **所有 Kubernetes 節點（Master / Worker / L4LB）**

👉 **全部使用同一個 ASN（Single-AS Fabric）**,模擬一個企業或資料中心內部的 routing domain。

### 5.2 BGP Session 類型(不變)

| 對等關係 | 類型 |
| --- | --- |
| TOR ↔ 所有 K8s 節點 | iBGP |
| K8s 節點彼此 | ❌ 不直接 Peering |

### 5.3 next-hop-self(新增,關鍵修正)

因為 `k8s-net` 是單一扁平網段(見第 4.1 節),**TOR 對所有 iBGP neighbor 必須設定 `next-hop-self`**(FRR 設定範例:`neighbor <peer-group> next-hop-self`)。

若不設,iBGP 預設會保留原始宣告者的 next-hop——也就是說,節點 B 學到節點 A 的 Pod CIDR 時,next-hop 會顯示成節點 A 自己的 IP,而不是 TOR。因為大家在同一個 L2 網段,節點 B 會直接 ARP 節點 A 並直連過去,完全繞過 TOR。這樣一來「TOR 是唯一 L3 hop、節點間不能直接互通」這個核心假設就破功了。

設了 `next-hop-self` 之後,所有節點看到的路由 next-hop 永遠是 TOR,轉發永遠先送到 TOR,由 TOR 查表後再送到正確的目的節點(即使目的節點其實跟來源在同一段 L2 上,封包還是會先繞去 TOR 再繞回來——這跟真實世界「router-on-a-stick」的行為完全一致,是刻意且正確的設計,不是缺陷)。

---

## 6. 元件角色（v2）

### 6.1 OpenStack Router（Mgmt Edge,角色已改變)

**角色**:單純提供 `mgmt-net` 的對外 SNAT 出口,不再是資料平面的一部分。

**職責**:

* 掛 `mgmt-net`,`enable_snat = true`
* 不掛 `k8s-net`,不知道任何 Pod、Service VIP、BGP 路由

📌 這比 v1 的角色設計更乾淨:v1 讓一個 Router 同時肩負「資料平面入口」與「一般連外」兩種語意,v2 把這兩件事徹底切開。

### 6.2 TOR VM（資料中心 L3 Fabric,新增 mgmt NIC + DNAT 規則)——**現況(v3)：DNAT 規則沒有實作,見上方 §0.1**

TOR 作為 iBGP route reflector、ECMP 轉發 Pod CIDR 流量的角色仍然成立
(§5、§6.3 都還是現況);以下的 DNAT 規則描述的是 v2 設計但從未落地成
Ansible role,因為服務流量的入口後來改成 Cloudflare Tunnel,不需要
TOR 做任何 NAT 了。

**角色**:Top-of-Rack Switch / L3 Fabric Router,同時是全架構唯一的 NAT 邊界。

**職責**:

* 兩張 NIC:
  * `k8s-net`(fabric,固定 IP `10.10.0.10`,同時是這個 subnet 的 `gateway_ip`)
  * `mgmt-net`(管理 + 對外服務入口,綁一個 Floating IP)
* 與所有 K8s 節點建立 iBGP,**開啟 `next-hop-self`**
* 接收兩類路由:
  1. **Service VIP (/32)** → 來自 L4LB 節點
  2. **Pod CIDR (172.16.x.x/xx)** → 來自所有 K8s 節點
* 一條本機 DNAT 規則:`mgmt-net 固定 IP → 內部 Service VIP`,把 Floating IP 進來的流量導入 fabric
* 對 Service VIP 執行 ECMP,對 Pod CIDR 做純 L3 轉發,兩者都**不做 NAT**

### 6.3 Kubernetes 節點（統一模型,新增 mgmt NIC)

> **所有 Kubernetes 節點,本質上都是一台「會跑 Pod 的路由器」**——這句話維持不變。

#### 共同職責

* 兩張 NIC:`k8s-net`(fabric)+ `mgmt-net`(一般連外)
* Default route 走 `mgmt-net`;Pod CIDR / Service VIP 等具體路由走 BGP,next-hop 永遠是 TOR
* 與 TOR 建立 iBGP,廣播自身持有的 Pod CIDR(172.16.x)
* 能直接路由到其他節點的 Pod(封包實際上會先經過 TOR)

### 6.4 L4LB 節點（Ingress Role,不變)——**現況(v3)：目前 dormant,`l4-0001`/`l4-0002` 實際是普通節點,見上方 §0.1**

* 在 `dummy0` 綁定 Service VIP(內部代表位址,例如 `172.31.255.1`)
* 透過 iBGP 向 TOR 宣告 `172.31.255.1/32`
* 不做 SNAT,僅負責 L4 分流與 DSR 導向

---

## 7. DSR（Direct Server Return）設計說明——**現況(v3)：這整節描述的路徑目前 dormant,見上方 §0.1;現在的實際外部流量路徑是 Cloudflare Tunnel → cloudflared → istio-ingressgateway(ClusterIP),見 `docs/packet-flows.html`**

### 7.1 NAT 邊界的精確位置(修正重點)

因為本 Lab **已具備完整 L3 Fabric 能力**,TOR 之後的路徑維持零 NAT:

* TOR 知道所有 Pod CIDR
* 所有節點之間 172.16.x 網段可直通
* 回程流量不需要再回到 L4LB

**與 v1 的差異只有一點**:Internet ↔ TOR 這一小段,因為要經過 Neutron Floating IP,是有 NAT 的。這段之外(TOR → L4LB → Pod → 回 TOR)完全比照 v1 的原始設計,沒有任何簡化。

### 7.2 流量方向（DSR)

#### Ingress（Client → Pod）

1. Client → Floating IP
2. Neutron NAT → TOR 的 `mgmt-net` 固定 IP
3. TOR 本機 DNAT → 內部 Service VIP
4. TOR → L4LB（ECMP,經 `k8s-net`)
5. L4LB → Pod（不改變 Source IP)

#### Egress（Pod → Client）

1. Pod 回應封包,Source IP = Pod IP(或 L4LB `dummy0` 上的 VIP,依你的 DSR 實作方式而定)
2. 直接經由 TOR → mgmt-net → Neutron(conntrack 自動把位址換回 Floating IP)→ Internet
3. **完全繞過 L4LB**,而且也不會重新經過 TOR 的 DNAT 規則(那條規則只作用在目的位址等於 TOR mgmt IP 的方向)

📌 L4LB **只存在於 ingress path**;TOR 是**唯一**出現位址轉換的節點,而且只在進站方向轉一次。

---

## 8. 流量生命週期（v2)——**現況(v3)：同上,這是 dormant 路徑的生命週期,不是現在的真實路徑,見 `docs/packet-flows.html` 的現行版本**

### Step 1:Internet → Floating IP

* Client 存取 `service.example.com` → DNS 解析到 Floating IP
* 封包進入 OpenStack,由 Neutron L3 agent 做 DNAT 到 TOR 的 `mgmt-net` 固定 IP

### Step 2:TOR 本機 DNAT

* TOR 收到目的位址 = 自己 `mgmt-net` IP 的封包
* `iptables`/`nftables` PREROUTING 規則把目的位址改寫成內部 Service VIP

### Step 3:TOR → L4LB（ECMP)

TOR 路由表狀態示意(所有 next-hop 因為 `next-hop-self` 都指向 TOR 自己學到的鄰居,不是原始宣告者):

```
172.31.255.1/32
  via 10.10.0.30 (l4-0001)
  via 10.10.0.31 (l4-0002)

172.16.0.0/16
  via 10.10.0.40 (ap-0001)
  via 10.10.0.41 (ap-0002)
```

* TOR 針對 VIP 做 ECMP
* 對 Pod CIDR 做最短路由

### Step 4:L4LB → Pod（DSR)

* 封包抵達 L4LB 的 `dummy0`
* L4LB 根據 Service 規則選 Pod
* **不改寫 Source IP**,直接送往目標 Pod IP（172.16.x)

### Step 5:Pod → Internet（回程)

* Pod 回應封包,走預設路由 → TOR → `mgmt-net` → Neutron NAT 換回 Floating IP → Internet
* **不經過 L4LB**,**不經過 TOR 的 DNAT 規則**(方向不同,不會命中該規則)

---

## 9. OpenStack 限制與必要設定(v2,具體到 Terraform 資源層級)

| 項目 | 說明 |
| --- | --- |
| `k8s-net` 不掛 Router | 資料平面完全交給 TOR 做 L3,Neutron 只提供 L2 |
| `k8s-net` subnet | `no_gateway = true`(實作採用,比原本設想的「gateway_ip 指向 TOR」更乾淨):這個網路完全不發 DHCP 預設路由,避免跟 `mgmt-net` 的 default route 打架,fabric 內的可達性全部靠 iBGP 學到的具體路由 |
| `mgmt-net` Router | `enable_snat = true`,獨立於資料平面 |
| Floating IP | 只配一個(現況 v3:綁在 **bastion** 的 `mgmt-net` port 上,只做 SSH/ops,不是服務入口,見上方 §0.1);不綁在任何其他節點 |
| Port Security(TOR、L4LB 的 `k8s-net` 介面) | **必須整段關閉**(`port_security_enabled = false`),不是「關閉或用 allowed_address_pairs 擇一」。實測發現 `allowed_address_pairs` 只解決 anti-spoofing(來源位址檢查),解決不了 Neutron OVS 的 conntrack 狀態防火牆問題:l4lb 這個 port 只會看到 DSR 的去程(SYN),因為設計上回程(SYN-ACK 以後)直接從 realserver 送回 client、繞過 l4lb,conntrack 永遠等不到它認定「established」需要的握手,client 後續的 ACK / 實際資料就被當 invalid state 擋掉。這是 DSR/非對稱路由跟 conntrack-based 防火牆的已知衝突,不是設定問題,無法只靠 allowed_address_pairs 繞過 |
| Port Security(node 角色的 `k8s-net` 介面) | 同樣測試後確認也要整段關閉:node 節點要接收目的位址是 Service VIP(而非自己 fixed IP)的封包,即使 `allowed_address_pairs` 已經放行該 VIP,這個 cloud 的 Neutron 後端實測仍然擋下對應的 ingress 流量 |
| Port Security(所有 VM 的 `mgmt-net` 介面) | 維持預設開啟即可,這段沒有轉發/偽造來源位址、也沒有 DSR 非對稱流量的需求 |
| Security Group | 除了原本的 SSH(22/tcp)、ICMP,**必須新增 TCP 179(BGP)**、**ICMPv6**(IPv6 Neighbor Discovery 依賴它),以及節點彼此之間轉發流量所需的規則 |
| IPv4 forwarding | TOR、所有 K8s 節點都必須開 |
| Reverse Path Filtering | TOR、所有 K8s 節點都必須關閉或放寬,否則 ECMP / DSR 封包會被 kernel 自己丟棄 |

---

## 10. 已知限制與替代方案(新增章節)

| 限制 | 原因 | 替代方案 |
| --- | --- | --- |
| 無法做到「真公網 IP + 無 NAT 的 ECMP」 | Neutron Floating IP 是 1:1 NAT,不是租戶可自助配置的 routed prefix | 用本文件的 Floating-IP-fronted 設計(唯一 NAT 邊界在 TOR);若必要,向雲平台營運商申請 BGP dynamic routing / routed provider network |
| TOR 是單點故障 | 本 Lab 刻意簡化,只有一台 TOR | 教學/demo 用途可接受;若要示範 TOR 高可用,需要兩台 TOR + anycast/VRRP,屬於進階題目,不在本版範圍 |
| `k8s-net` 是共用 L2,不是實體隔離的 point-to-point | 用 `next-hop-self` 在協定層強制流量走 TOR,而非用實體拓樸強制 | 若要更貼近真實機櫃佈線(每個節點與 TOR 各自獨立網段),需要每條 link 各開一個 network/subnet,TOR 需要對應數量的 NIC,資源數量會隨節點數線性增加,且會受 OpenStack flavor 的 NIC 上限限制 |
| IPv6 是否需要 global subnet | 若只是要 BGP over IPv6 link-local,不需要;若要真的測 IPv6 pod networking,才需要保留 `fd00:1::/64` | 依實際測試需求取捨,兩者都不影響本文件其餘設計 |

---

## 11. 本 Lab 在模擬什麼「真實世界」

這個 Lab 等價於:

* 一個企業內部資料中心
* 單一 Routing Domain
* TOR 作為 L3 Fabric,同時也是進出這個資料中心的邊界 NAT 設備(這點其實也很真實——很多企業資料中心對外也是經過邊界防火牆/NAT 設備,而不是每個內部位址都真的可被公網直接路由)
* Kubernetes 節點即是 Fabric 成員
* Pod IP 在 Cluster Network 內是真實路由物件;Service VIP 對外則透過邊界 NAT,對內仍是真實路由物件

---

## 12. 總結一句話（v2)

> **這是一個「Kubernetes 跑在資料中心路由架構裡」的實驗,對外邊界誠實地承認自己是租來的雲、需要過一次 NAT;但邊界之後,BGP、ECMP、DSR、Pod CIDR 路由全部都是真實行為,不是模擬出來的效果。**

**現況(v3)補充**:「對外邊界過一次 NAT」這句話仍然成立,只是邊界機制換了
——現在是 Cloudflare Tunnel(cloudflared 主動撥出到 Cloudflare 邊緣,不是
Neutron Floating IP 的進站 NAT),邊界之後(cloudflared → istio-ingressgateway
→ Pod)一樣是真實的 Cilium native routing,不是模擬效果。BGP/ECMP/DSR 這套
機制被證明可行、且塑造了現在架構的關鍵決定(見上方 §0.1),但目前的服務流量
不走這條路徑,詳見 `docs/network-architecture.html`、`docs/packet-flows.html`、
`docs/l4lb-history.html`。
