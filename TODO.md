1 安裝 cert manager, 使用 cloudflare 提供的 root cert 來讓我們 expose https 服務
2 安裝 Kubernetes Dashboard, 記得用 cert manager 提供的 issuer 搭配 istio expose 成 https 能用就好 可以不用掛PVC
3 安裝 hubble 來觀測 cilium 流量, 記得用 cert manager 提供的 issuer 搭配 istio expose 成 https
4 安裝 kube-prometheus-stack, 記得用 cert manager 提供的 issuer 搭配 istio expose 成 https (alert manager, prometheus, grafana) 能用就好 可以不用掛PVC
6 bastion也安裝tunnel 但是是不同一條


7 worker打上worker標籤 lb打上l4標籤
8 bastion安裝k9s kubectl-alias 以及開啟kubectl自動補全功能
9 不要用我的key當作bastion ssh 到節點的key 我的key的私密金鑰不可以外流 bastion ssh 到節點請使用auto generate的key
1 bastion /userap要永久保留
2 bastion 設定nfs
5 安裝 NFS CNI 並支援RWX，NFS使用
9 bastion runner -> 

10 runner 禁止給public repo使用 所以單獨開一個cd repo
10 安裝argo cd
11 安裝vault