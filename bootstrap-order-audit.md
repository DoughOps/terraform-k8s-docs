# 從零建置順序稽核紀錄(2026-07-30)

這份文件記錄一次「不相信任何單一文件、直接看 Terraform/Ansible 原始碼跟 git
歷史」的稽核結果。起因是 `CLAUDE.md`、`ansible/README.md` 對建置順序的描述
(先跑完整個 `bastion.yml`,再跑 `k8s.yml`)跟實際程式碼的相依關係對不上。

## 發現 1:對外服務入口的設計文件已經過時

`docs/arch_design.md`、`docs/implement.md` 是同一次 commit(`6489b8e`)寫的
v2 設計,核心主張是:Floating IP 綁在 TOR、TOR 本機 DNAT 改寫成內部 Service
VIP、L4LB 節點用 IPVS-DR 對 Pod 做 DSR——這是全架構唯一的 NAT 邊界。

但後續兩次 commit 已經整個取代這個對外路徑:

* `3244cdd`「install Istio + test web app, exposed externally via bastion's
  floating IP」——Floating IP 先從 TOR 移到 bastion。
* `bdc7871`「replace bastion floating-ip exposure with Cloudflare Tunnel」——
  接著整個放棄「FIP 對外服務」,改用 Cloudflare Tunnel。

現況(已用程式碼逐項驗證,不是猜測):

| 設計文件說的 | 實際現況 | 證據 |
| --- | --- | --- |
| Floating IP 綁在 TOR,對外服務入口 | Floating IP 綁在 **bastion**,只做 SSH/ops | `main.tf` 的 resource 叫 `bastion_fip`,`fixed_ip` 指向 bastion 的 mgmt IP |
| TOR 本機 DNAT:mgmt IP → 內部 Service VIP | **沒有任何 Ansible role 實作這條規則** | 全 repo 搜尋 `dnat`/`prerouting`/`iptables`/`nft` 在 `ansible/roles` 下零命中 |
| L4LB 節點(`l4-0001`/`l4-0002`)用 IPVS-DR 宣告 Service VIP、對 Pod 做 DSR | **這條 Terraform 分支目前沒有任何 VM 在用** | `terraform.tfvars` 裡 `l4-0001`/`l4-0002` 的 `bgp_role` 都是 `"peer"`,不是 `"l4lb"`;`main.tf:146-148` 自己註解「這次的 tfvars 沒有用到 'node'/'l4lb' 角色⋯不影響目前的 'peer' 角色」;沒有任何 Ansible role 配置 dummy0/IPVS/keepalived,`l4-0001`/`l4-0002` 只被 `node_labels` role 貼上 `node-role.kubernetes.io/l4` 標籤,功能上與 worker 無異 |
| 對外流量走 TOR → L4LB(ECMP)→ Pod(DSR) | 實際走 **Cloudflare → cloudflared(叢集內 pod)→ istio-ingressgateway(ClusterIP)** | `roles/istio/templates/gateway-values.yaml.j2` 明講:`service.type: ClusterIP`,因為這個 OpenStack tenant 沒有 LBaaS,`LoadBalancer` 類型的 Service 會永遠卡 `<pending>` |
| Pod CIDR 靠 `terraform.tfvars` 的靜態 `announce_prefix` 宣告 | 實際是 **Cilium 執行期間動態塞進 FRR** | `roles/cilium/tasks/bgp_announce.yml`:讀 `kubectl get ciliumnode -o jsonpath={.spec.ipam.podCIDRs[0]}`(2026-08-06 起,`ipam.mode` 從 `kubernetes` 改成 `cluster-pool` 之後改讀這個欄位,原本是 `kubectl get node -o jsonpath={.spec.podCIDR}`),用 vtysh 加一條 distance=200 的 Null0 route 當「後盾」,再用 `network` 陳述式宣告——`announce_prefix` 這個 tfvars 欄位目前沒有任何節點在用 |

`docs/l4lb-history.html` 有記錄「DSR + IPVS + ECMP」這套機制曾經在一個獨立的
5-VM 驗證環境(`node-a`/`node-b`/`l4lb-0001`/`l4lb-0002`)裡跑通,並得出
「`port_security_enabled` 必須整段關閉」「iBGP fabric 真的能做 ECMP」這兩個
影響到現在架構的結論——但那一頁講的是**已經被取代的舊拓樸**,沒有提到「現在
這個拓樸裡的 `l4-0001`/`l4-0002` 其實沒有真的在跑 DSR」這件事。這一段目前
只有這份稽核文件記錄下來,`arch_design.md`/`implement.md` 的對外服務入口章節
(§2、§4.3、§6.2、§6.4、§7、§8)之後應該補一段「現況」說明,標記哪些是
現在真的在跑的行為、哪些是保留給以後接回去的設計(本次稽核先聚焦在下面的
建置順序問題,這段留待下次處理)。

## 發現 2:「先跑 `bastion.yml`,再跑 `k8s.yml`」在全新環境上跑不完

`CLAUDE.md`、`ansible/README.md` 都說全新環境的順序是「`bastion.yml` 整個跑完
→ `k8s.yml` 整個跑完」。但 `bastion.yml` 的 import 順序是:

```
access.yml → ssh-tunnel.yml → nfs-server.yml → kubeconfig.yml →
apiserver-dns.yml → tools.yml → cloudflare-tunnel.yml → github-runner.yml
```

第 4 步 `kubeconfig.yml` 直接用 `ansible.builtin.fetch` 去 masters[0] 抓
`/etc/kubernetes/admin.conf`——這個檔案要 `kubeadm init` 跑過才存在,而
`kubeadm init` 是 `k8s/kubeadm.yml`(屬於 `k8s.yml`,照文件說的順序**還沒
跑**)才會做的事。`ansible.builtin.fetch` 預設在來源檔案不存在時直接 fail
整個 play,不會靜默跳過。也就是說:在真正全新的環境上單獨執行
`playbooks/bastion.yml`,會在第 4 步當場失敗,後面的 `apiserver-dns.yml`/
`tools.yml`/`cloudflare-tunnel.yml`/`github-runner.yml` 根本不會執行到。

`docs/getting-started.html`(目前 repo 內最新、最詳細的建置指南,
2026-07-27 更新)其實已經繞開這個問題——它沒有叫使用者跑整個
`bastion.yml`/`k8s.yml`,而是把每個子 playbook 個別列出來,並且把
`bastion/cloudflare-tunnel.yml`、`bastion/ssh-tunnel.yml` 排在
`k8s/istio.yml`/`k8s/cert-manager.yml` 之後才執行。這證明**正確的細粒度順序
其實已經有人摸索出來**,只是 `CLAUDE.md`/`ansible/README.md` 對兩個聚合
playbook(`bastion.yml`/`k8s.yml`)的描述,把「bastion 重建、叢集已存在」
這個情境跟「從 0 建置、叢集還不存在」這個情境混為一談了——兩個聚合 playbook
在前者可以整個直接跑,在後者不行。

另外還有一條沒被文件強調、但確實存在的跨 playbook 相依:`k8s/nfs-csi.yml`
(以及 `k8s/docs-site.yml`)讀的 `nfs_export_path` 指向
`bastion/nfs-server.yml` 建立的匯出目錄,**必須先跑過 `nfs-server.yml`**,
`nfs-csi.yml` 才有東西可掛。

## 修正:讓 `bastion.yml` 真的可以當一個獨立 playbook 跑

沒有選擇「把 `bastion.yml` 拆開個別跑」這條路(那只是把問題丟給操作者記順序),
而是修改兩個會在叢集還不存在時**硬失敗**的地方,讓它們改成「偵測到叢集還沒
準備好就跳過,並印出清楚的訊息」,呼應 repo 裡其他 role 已經在用的
「偵測狀態、用 `when` 守衛」風格(例如 `roles/cloudflare_tunnel` 原本就有的
「只有 token 真的換了才重啟 deployment」邏輯):

1. **`playbooks/bastion/kubeconfig.yml`**:抓 `admin.conf` 前先 `stat` 檢查
   masters[0] 上這個檔案存不存在;不存在就跳過 fetch/copy,但 `kubectl_cli`
   role(裝 kubectl 這支 CLI 本身)維持無條件執行,不受影響。
2. **`roles/cloudflare_tunnel/tasks/main.yml`**:在 token 檢查之後,新增一個
   對 bastion 上 `~/.kube/config` 存不存在的檢查;不存在就跳過
   `kubectl apply`/`rollout restart`/`rollout status` 這幾步,印出訊息說明
   還沒部署的原因。

這兩個修正只解決「不要硬失敗」,不解決「叢集還沒建立時 cloudflared physically
不可能部署成功」這個真實限制——所以還需要第二步:把
`bastion/cloudflare-tunnel.yml` 這個 import 從 `bastion.yml` 移到
`playbooks/k8s.yml`(放在 `cert-manager.yml` 之後),讓它在全新建置流程裡
自己找到「叢集終於活了」的那個時間點:

3. **`playbooks/k8s.yml`**:`cert-manager.yml` 之後新增
   `- import_playbook: bastion/cloudflare-tunnel.yml`,同時把它從
   `playbooks/bastion.yml` 的 import 鏈裡拿掉(不是兩邊都留)。原本以為要
   仿照 `kubeconfig.yml` 那樣兩邊各留一份(那個 role 服務「bastion 被重建」
   情境),但這個假設是錯的:`cloudflare-tunnel.yml` 部署的
   Deployment/Secret 活在叢集自己的 etcd、跑在一般 k8s 節點的 pod 上,
   完全不是 bastion 本機的東西——bastion 被重建根本不會影響它,沒有「需要
   restore」這件事,留在 `bastion.yml` 裡只是多餘的重複匯入。真正需要重跑
   它的情境是 Cloudflare 那邊的 tunnel token 換了,這時候直接單獨執行
   `scripts/ansible.sh ansible-playbook playbooks/bastion/cloudflare-tunnel.yml`
   就好(`cloudflare/README.md` 本來就是這樣寫的),不需要透過任何聚合
   playbook。

效果:`scripts/ansible.sh ansible-playbook playbooks/bastion.yml` 現在可以在
任何時間點(叢集存在與否都一樣)當成單一指令執行,不會再半路 abort;
`k8s.yml` 跑完之後 cloudflared 已經自動部署好,不需要、也不會再回頭跑
`bastion.yml`。

## 驗證後的真實建置順序(供對照 `docs/getting-started.html`)

```
1. terraform apply                              # root,建 OpenStack VM/網路;openstack_compute_keypair_v2 順便把 .ssh/id_ed25519.pub 註冊進 OpenStack,Nova 開機時統一埋進全部節點
2. (cd cloudflare && terraform apply)            # 獨立 state,不依賴 #1,見 getting-started.html Step 5-6
3. 把 cloudflare/ 的 output 搬進 ansible 的 secrets.yml / group_vars/all/main.yml(Step 7)
4. scripts/ansible.sh ansible all -m ping         # 確認全部節點連得到(只有一把 key,沒有 bootstrap 步驟,見 Step 8)
5. scripts/ansible.sh ansible-playbook playbooks/bastion.yml      # 一次跑完,kubeconfig 這步會先安全跳過(叢集還不存在)
6. scripts/ansible.sh ansible-playbook playbooks/k8s.yml          # kubeadm.yml 把 kubeconfig 裝回 bastion;cert-manager 之後部署 cloudflared
7. 驗證:playbooks/k8s/smoke-test.yml + curl 各個 *.dough-ops.com hostname 應該回 302(見 cloudflare/README.md)
```

（2026-07-30 事後補充:原本這裡第 4 步是「產生一把獨立的 bastion 內部 key、
跑 `BOOTSTRAP=1` 佈署」,後來設計改成只用一把 key、Nova 開機時直接埋進
全部節點,不再需要這個 bootstrap 步驟,上面已經更新成最終版本。)

之後如果只有 bastion 被重建(叢集本來就活著),重跑一次
`playbooks/bastion.yml` 就會把 bastion 本機狀態(kubectl/kubeconfig、
`/etc/hosts`、k9s、bastion 自己的 web-SSH tunnel、GitHub runner 註冊)全部
補回來——不含 cloudflared,那個不需要、也不該靠 `bastion.yml` 補,因為
它從來不是 bastion 本機狀態的一部分。
