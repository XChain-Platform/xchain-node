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

### Install xchain-node 
```
git clone git@github.com:XChain-platform/xchain-node.git
cd xchain-node
npm install
sudo ln -s ~/xchain-node/xchain-node.sh /usr/local/bin/xchain-node
```

