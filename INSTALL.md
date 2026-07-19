# XChain Node Setup Notes
Below are the instructions to install and setup an xchain-node on Ubuntu 24.04

### Update packages
```
sudo apt-get update
sudo apt-get upgrade
```

### Install node and npm
```
sudo apt install nodejs npm
```

### Prepare for docker install
```
sudo apt install ca-certificates curl gnupg -y
```

### Add docker official GPG key
```
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
```

### Add docker repo
```
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

### Install docker engine
```
sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin -y
```

### Add your user to the docker group 
```
sudo usermod -aG docker `id -un`
newgrp docker
```

### (Optional) Relocate Docker storage off the root disk

On boxes with a small root disk and a big data disk, operators move Docker's
data-root onto the big disk via `/etc/docker/daemon.json`:

```
{ "data-root": "/misc/docker" }
```

Important: this setting moves Docker's own image + overlay2 store, but it does
NOT move the **containerd** content/snapshot store, which stays at
`/var/lib/containerd` on the root disk and keeps growing as images are pulled,
eventually filling `/`. If you relocate the data-root, relocate containerd too:
point its `root` at the same disk in `/etc/containerd/config.toml`
(or bind-mount `/var/lib/containerd`), then restart both daemons:

```
sudo systemctl restart containerd docker
```

`xchain-node`'s precheck prints a warning on every command when it detects a
relocated Docker data-root with containerd still on `/`. If your containerd
root lives at a non-default path, set `XCHAIN_NODE_CONTAINERD_ROOT` to that path
to silence the check.

### Install xchain-node 
```
git clone git@github.com:XChain-platform/xchain-node.git
cd xchain-node
npm install
sudo ln -s ~/xchain-node/xchain-node.sh /usr/local/bin/xchain-node
```

