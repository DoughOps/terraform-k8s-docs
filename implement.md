# Lab 內部資源實作說明書

**（VM / OS / Routing / Kubernetes 行為定義 — v2,對齊 `arch_design.md` v2)**

---

## 1. 本文件定位

本文件定義的是:

> **在 OpenStack 資源已正確 provision 的前提下,每一個 VM 類型在「作業系統層與網路層」必須具備的能力與設定。**

本文件不關心:

* VM 如何被建立
* 設定如何被套用
* 設定檔放在哪
* 使用哪一套自動化工具

v2 相對 v1 的變化,全部源自 `arch_design.md` v2 的兩個修正:(1) 資料平面 `k8s-net` 不再掛 Neutron Router,改由 TOR 當 L3 閘道;(2) 每台 VM 多一張 `mgmt-net` NIC 負責一般連外與 SSH。詳見該文件第 0 章的修訂說明。

> **現況(v3,2026-07-30)**:`arch_design.md` §0.1 記錄了後續的現況修正——
> 對外服務入口已經從「Floating IP 綁 TOR + 本機 DNAT + L4LB DSR」換成
> Cloudflare Tunnel,Floating IP 現在綁在 bastion 只做 SSH/ops。本文件
> 底下 §2(TOR)、§4(L4LB)兩節描述的行為,現在對應到「目前 dormant、
> 沒有任何 VM 在跑」的狀態,個別段落已標記;其餘章節(§3 一般節點的網路
> 模型、port security、kernel 設定)完全不受影響,仍是現況。

---

## 2. TOR VM（資料中心 L3 Fabric,新增 mgmt NIC + DNAT)

### 2.1 TOR VM 的角色再定義

TOR VM 在本 Lab 中 **不是伺服器**,而是:

> **一台用 Linux + FRRouting 模擬的資料中心 L3 Switch / Fabric Router,同時也是全架構唯一的 NAT 邊界**

它是:

* 所有外部流量的第一個 L3 Hop
* 所有 iBGP session 的集中點
* ECMP 決策的唯一位置
* Neutron Floating IP 進站流量的終點(NAT 邊界)

### 2.2 網路介面(新增)

TOR VM 必須有 **兩張網卡**,角色不可互換:

| 介面 | 網路 | 用途 |
| --- | --- | --- |
| NIC 1(fabric) | `k8s-net`,固定 IP `10.10.0.10` | iBGP peering、ECMP 轉發、Pod CIDR / Service VIP 路由。同時是 `k8s-net` subnet 的 `gateway_ip`,所有節點的預設閘道 |
| NIC 2(mgmt) | `mgmt-net` | 一般連外、SSH 管理入口、綁定**本 Lab 唯一的一個 Floating IP** |

📌 兩張網卡的 port security 要求不同,見第 2.5 節。

### 2.3 必須安裝的軟體

TOR VM 必須具備以下能力:

| 類型 | 說明 |
| --- | --- |
| Routing Daemon | 支援 BGP（iBGP） |
| Multipath Routing | Kernel 必須支援 ECMP |
| IPv6 | 支援 IPv6 link-local(BGP over v6 用,和是否配置 global IPv6 subnet 無關) |
| Packet Filter(新增) | `iptables` 或 `nftables`,用來設定第 2.6 節的 DNAT 規則 |

📌 **實務等價物**:資料中心交換器的 control plane,外加邊界 NAT 設備的角色。

### 2.4 Kernel / OS 層必要設定

TOR VM **必須啟用路由器行為**:

* IPv4 forwarding:**必須開**
* IPv6 forwarding:**建議開**
* Reverse Path Filtering:**必須調整**(否則 ECMP / DSR 封包會被丟棄)
* ICMP / Neighbor Discovery:**不可被過度限制**(BGP transport 依賴)

📌 **設計原因**:TOR 是「轉發設備」,不是 endpoint。

### 2.5 Port Security(新增,關鍵)

* NIC 1(`k8s-net`,fabric):**必須關閉 port security,或用 `allowed_address_pairs` 明確放行**所有 Pod CIDR(`172.16.0.0/16`)與 Service VIP(`172.31.255.1/32` 或你實際選用的網段)。否則 Neutron 的 anti-spoofing 會擋掉 TOR 轉發的所有非本機來源封包——TOR 的核心工作就是轉發別人的封包,port security 預設行為與這個角色直接衝突。
* NIC 2(`mgmt-net`):維持預設 port security 開啟即可。這張介面上 TOR 只是一般端點(SSH、出站流量、Neutron 已經處理好的 Floating IP NAT),沒有轉發或偽造來源位址的需求。

### 2.6 本機 DNAT 規則(新增)——**現況(v3)：沒有實作,見上方現況說明與 `arch_design.md` §0.1**

TOR 必須設定一條 `PREROUTING` DNAT 規則,把「目的位址 = 自己 `mgmt-net` 固定 IP」的封包,改寫成內部 Service VIP,再交給正常的路由表(此時 FRR 學到的 ECMP 路由就會接手)。

範例語意(不規定用哪個工具):

```
目的位址 = TOR 的 mgmt-net 固定 IP, 目的埠 = 服務埠
  → DNAT 到 內部 Service VIP:同一埠
```

📌 這條規則只在**進站方向**命中。回程封包(Pod → Client)不會經過這條規則,conntrack 會在離開 TOR 的 `mgmt-net` 介面時自動把來源位址換回(由 Neutron 的 Floating IP NAT 處理),TOR 端不需要額外處理回程。

### 2.7 FRRouting（BGP）行為要求

TOR VM 的 BGP 行為語意必須符合以下條件:

#### BGP Role

* ASN:與所有 K8s 節點相同
* 類型:iBGP
* **`next-hop-self`:必須對所有 iBGP neighbor 開啟**(新增,關鍵)
* 不對外宣告任何路由

📌 **為什麼一定要開 `next-hop-self`**:`k8s-net` 是單一扁平 L2 網段(見 `arch_design.md` 4.1 節),如果不設 `next-hop-self`,節點學到的路由 next-hop 會是原始宣告節點自己,節點之間就能直接 ARP 互連,完全繞過 TOR。開了之後,所有節點看到的 next-hop 永遠是 TOR,轉發永遠得先經過 TOR 查表——這是本 Lab 唯一 L3 hop 假設能否成立的關鍵設定,原始 v1 文件沒有提到這點。

#### 必須接收的路由類型

1. **Service VIP**
   * Prefix:`/32`
   * 來源:L4LB Nodes
   * 多條 next-hop 必須同時存在（ECMP）

2. **Pod CIDR**
   * Prefix:`172.16.x.x/xx`
   * 來源:所有 K8s 節點
   * 每個 CIDR 對應一個節點

#### Forwarding 行為

* 對 Service VIP 啟用 ECMP
* 對 Pod CIDR 做單一路由轉發
* 在 fabric 側(NIC 1)**不做 NAT**;NAT 只發生在 2.6 節描述的 mgmt 側單一規則

### 2.8 TOR VM 不該做的事

* ❌ 不安裝 Kubernetes
* ❌ 不持有 Service VIP
* ❌ 不參與任何 Service 邏輯
* ❌ 不對 Pod 做負載均衡
* ❌ 不在 fabric 側(NIC 1)做任何 NAT

---

## 3. Kubernetes 節點（通用節點模型,新增 mgmt NIC)

> **在這個 Lab 裡,Kubernetes Node = 一台會跑 Pod 的路由器**——這句話是整份設計的核心,維持不變。

### 3.1 網路介面(新增)

不論 Master、Worker、L4LB,每個節點都需要 **兩張網卡**:

| 介面 | 網路 | 用途 |
| --- | --- | --- |
| NIC 1(fabric) | `k8s-net`,固定私有 IP(依 `terraform.tfvars` 指定) | iBGP peering、Pod CIDR / Service VIP 路由。預設閘道自動指向 TOR(subnet `gateway_ip`) |
| NIC 2(mgmt) | `mgmt-net` | 一般連外(apt、image pull 等)、透過 TOR jump host SSH 進來 |

📌 **Default route 走 NIC 2(`mgmt-net`)**,不是 BGP 學來的。Pod CIDR、Service VIP 這些具體路由透過 BGP 學到,next-hop 永遠是 TOR,會自動比 default route 更精確,兩者不衝突。這正是原設計「❌ 不應宣告 Default Route」精神的具體實作方式——default route 本來就不該、也不需要從 BGP 拿。

### 3.2 所有 K8s 節點的共同需求

#### 系統能力

* 能執行 Kubernetes 元件
* 能執行 BGP daemon
* 能修改 routing table
* 能處理非本機 IP 的封包

### 3.3 Kernel / OS 必要設定（關鍵）

#### L3 Routing 能力

* IPv4 forwarding:**必須開**
* Reverse Path Filtering:**必須關閉或調整為寬鬆模式**
* ARP 行為:**不得回應非本機 IP**（避免 ARP Flux）

📌 **設計原因**:Pod CIDR 是「路由來的」,不是 interface 上的 IP。

### 3.4 Port Security(新增)

* NIC 1(`k8s-net`,fabric):一般 K8s 節點(非 L4LB)如果只轉發自己的 Pod CIDR 流量,通常靠 `allowed_address_pairs` 放行自己的 Pod CIDR 即可,不需要整條介面關閉 port security。L4LB 節點的額外要求見第 4.4 節。
* NIC 2(`mgmt-net`):維持預設開啟。

### 3.5 BGP 行為（所有節點）

#### BGP Role

* ASN:與 TOR 相同
* 類型:iBGP
* Peering 對象:只與 TOR

#### 必須宣告的路由

* **自身 Pod CIDR**,例如:`172.16.x.0/24`,代表「這個節點可以直達這段 Pod Network」

#### 不應宣告的路由

* ❌ Service VIP(只有 L4LB 宣告)
* ❌ Default Route(本來就該走 `mgmt-net`,不是 BGP)
* ❌ External Network

---

## 4. L4LB 節點（Ingress 特化角色)——**現況(v3)：目前 dormant,`l4-0001`/`l4-0002` 實際是普通節點,沒有任何 VM 套用這節描述的能力,見上方現況說明與 `docs/l4lb-history.html`**

L4LB 節點 **不是獨立類型 VM**,而是:

> **在「通用 K8s 節點」上疊加 Ingress 能力**

### 4.1 額外必須具備的能力

#### Service VIP 管理

* 在非實體介面（如 `dummy0`）上綁定 Service VIP
* VIP 必須是:`/32`,不參與 ARP 廣播

#### BGP 行為（差異點）

* **額外宣告 Service VIP (/32)**
* 當節點不可用時,路由必須自動撤回

### 4.2 L4 負載與 DSR 行為

L4LB 節點必須做到:

* 接收 VIP 流量
* 根據 Service 規則選 Pod
* **不改寫 Source IP**
* 直接把封包送往 Pod IP（172.16.x)

📌 **設計語意**:L4LB 是 ingress dispatcher,不是 proxy。

### 4.3 L4LB 節點不該做的事

* ❌ 不做 SNAT
* ❌ 不做 egress gateway
* ❌ 不承擔 Pod-to-Pod 流量
* ❌ 不對外(`mgmt-net`)提供任何服務入口——服務入口只在 TOR

### 4.4 Port Security(新增)

* NIC 1(`k8s-net`,fabric):**必須用 `allowed_address_pairs` 放行 Service VIP**(`dummy0` 上綁的那個 `/32`),否則 L4LB 送出「來源位址是 VIP」的封包會被 Neutron 擋下,DSR 就無法運作。
* NIC 2(`mgmt-net`):維持預設開啟。

---

## 5. Kubernetes Pod（資料平面）

### 5.1 Pod Network 的假設前提

* 每個 Pod IP 都來自某個節點的 Pod CIDR
* 該 CIDR 已透過 BGP 被 TOR 與其他節點知曉
* Pod IP 在整個 Cluster Network **L3 可達**

### 5.2 Pod 的預期行為

* 預設路由指向所在節點
* 回應 Client 流量時:Source IP = Pod IP,不經過 L4LB

📌 **這正是 DSR 的成立條件**。

---

## 6. 管理用元件（非資料平面）

### 6.1 管理存取（SSH,已更新)

* 所有 VM 的管理存取,一律走 `mgmt-net`
* 只有 TOR 綁 Floating IP;其餘節點透過 TOR 當 jump host,用 `k8s-net` 或 `mgmt-net` 私有 IP 連線(兩者皆可,但語意上建議走 `mgmt-net`,和資料平面完全分離)

📌 **原則**:管理便利 ≠ 流量設計的一部分。這個原則在 v2 因為多了獨立 `mgmt-net`,反而落實得更徹底。

---

## 7. 行為驗證（資源層級)

本文件定義的每一項資源,**最終都應該能用以下方式被驗證**:

* TOR:
  * 能同時看到多條 VIP next-hop
  * 能看到完整 Pod CIDR routing table,且每一條的 next-hop 都是宣告節點本身(這是 TOR 自己學到的視角,不是靠 next-hop-self 改寫的)
  * 從外部連 Floating IP 能打到內部 Service VIP(驗證 DNAT 規則生效)

* K8s Node:
  * 能 ping 到任意其他節點的 Pod IP,不需經過 NAT
  * 看到的路由表裡,所有非本機路由的 next-hop 都是 TOR(驗證 `next-hop-self` 生效)
  * Default route 是 `mgmt-net`,不是 BGP 學來的

* L4LB:
  * 僅 ingress 有流量
  * egress 流量不回來

---

## 8. 總結（這份文件的價值)

> **這份文件不是教你怎麼設定,而是定義「設定完成後應該是什麼樣子」。**

只要你未來的實作結果:

* 行為符合這裡的描述
* 邏輯沒有違背角色邊界

那麼不論你用什麼工具、什麼寫法,
**這個 Lab 都是正確、可解釋、可教學的。**
