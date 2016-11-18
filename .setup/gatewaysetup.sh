#########################################################################
#  Gateway setup script for RaspberryPi
#  LowPowerLab.com/gateway
#########################################################################
#!/bin/bash

RED='\033[1;31m'
GRN='\033[1;32m'
YLW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${GRN}#########################################################################${NC}"
echo -e "${GRN}#                 Low Power Lab Gateway App Setup                       #${NC}"
echo -e "${GRN}#########################################################################${NC}"
echo -e "${YLW}Note: script can take long on older Pis${NC}"
echo -e "${YLW}Note: setup requires your input at certain steps${NC}"

# #update apt-get, distribution, kernel
echo -e "${CYAN}************* STEP: Running apt-get update *************${NC}"
sudo apt-get update
# echo -e "${CYAN}************* STEP: Upgrading distribution *************${NC}"
# sudo apt-get upgrade
# echo -e "${CYAN}************* STEP: Running dist-upgrade *************${NC}"
# sudo apt-get dist-upgrade
#sudo apt-get clean

echo -e "${CYAN}************* STEP: Installing git *************${NC}"
sudo apt-get -y install git

#install NGINX
echo -e "${CYAN}************* STEP: Install latest NGINX *************${NC}"
#echo "deb http://mirrordirector.raspbian.org/raspbian/ stretch main contrib non-free rpi" | sudo tee -a /etc/apt/sources.list
#sudo apt-get update
sudo apt-get -y install nginx
#sudo sed -e '/stretch/ s/^#*/#/' -i /etc/apt/sources.list
#sudo apt-get update

# echo -e "${CYAN}************* STEP: Install PHP5 *************${NC}"
sudo apt-get -y install php5-common php5-cli php5-fpm

#install NodeJS
echo -e "${CYAN}************* STEP: Install NodeJS *************${NC}"
if $(uname -m | grep -Eq ^armv6); then
  mkdir ~/tempnode -p
  cd ~/tempnode
  wget https://nodejs.org/dist/v4.6.2/node-v4.6.2-linux-armv6l.tar.gz
  tar -xzf node-v4.6.2-linux-armv6l.tar.gz
  sudo rm node-v4.6.2-linux-armv6l.tar.gz
  sudo rm -rf /opt/node
  sudo mv node-v4.6.2-linux-armv6l /opt/node/
  cd ~/
  sudo rm -rf ~/tempnode;
  sudo unlink /usr/bin/node;
  sudo unlink /usr/sbin/node;
  sudo unlink /sbin/node;
  sudo unlink /usr/local/bin/node;
  sudo unlink /usr/bin/npm;
  sudo unlink /usr/sbin/npm;
  sudo unlink /sbin/npm;
  sudo unlink /usr/local/bin/npm;
  sudo ln -s /opt/node/bin/node /usr/bin/node;
  sudo ln -s opt/node/bin/node /usr/sbin/node;
  sudo ln -s /opt/node/bin/node /sbin/node;
  sudo ln -s /opt/node/bin/node /usr/local/bin/node;
  sudo ln -s /opt/node/bin/npm /usr/bin/npm;
  sudo ln -s /opt/node/bin/npm /usr/sbin/npm;
  sudo ln -s /opt/node/bin/npm /sbin/npm;
  sudo ln -s /opt/node/bin/npm /usr/local/bin/npm;
else
  curl -sL https://deb.nodesource.com/setup_4.x | sudo -E bash -;
  sudo apt-get -y install nodejs;
fi


echo -e "${CYAN}************* STEP: Setup Gateway app & dependencies *************${NC}"
sudo mkdir /home/pi/gateway -p         #main dir where gateway app lives
cd /home/pi/gateway
#could use git clone but that requires empty target directory which won't work if executed repeatedly
#git clone --single-branch https://github.com/LowPowerLab/RaspberryPi-Gateway.git /home/pi/gateway
git init
git remote add origin https://github.com/LowPowerLab/RaspberryPi-Gateway.git
git pull origin master
sudo npm install --unsafe-perm --build-from-source
sudo npm cache clean    #clear any caches/incomplete installs
sudo mkdir /home/pi/gateway/logs -p

#create self signed certificate
#WARNING: must do this *AFTER* the gateway app was git-cloned
echo -e "${CYAN}************* STEP: Create self signed HTTPS certificate (5 year) *************${NC}"
sudo mkdir /home/pi/gateway/data/secure -p
sudo openssl req -new -x509 -nodes -days 1825 -newkey rsa:2048 -out /home/pi/gateway/data/secure/server.crt -keyout /home/pi/gateway/data/secure/server.key -subj "/C=US/ST=MI/L=Detroit/O=LowPowerLab/OU=IoT Department/CN=lowpowerlab.com"
sudo chown -R pi:pi /home/pi/gateway

#create HTTP AUTH credentials
echo -e "${CYAN}************* STEP: Create HTTP AUTH credentials *************${NC}"
HTTPUSER=$(whiptail --inputbox "\nEnter the Gateway http_auth username:" 8 78 "pi" --title "Gateway HTTP_AUTH Setup" --nocancel 3>&1 1>&2 2>&3)
HTTPPASS=$(whiptail --inputbox "\nEnter the Gateway http_auth password:\nNote: only first 8 characters matter (the rest are ignored)" 10 78 "raspberry" --title "Gateway HTTP_AUTH Setup" --nocancel 3>&1 1>&2 2>&3)
echo -e "$HTTPUSER:$(perl -le "print crypt("$HTTPPASS","passwordSALT")")" | sudo tee -a /home/pi/gateway/data/secure/.htpasswd

echo -e "${CYAN}************* STEP: Copy default site config to sites-available *************${NC}"
cp -rf /home/pi/gateway/_piConfigs/default /etc/nginx/sites-available/default
sudo ln -s /etc/nginx/sites-available/default
sudo service nginx restart

echo -e "${CYAN}************* STEP: ATXRaspi shutdown script setup *************${NC}"
if (whiptail --title "ATXRaspi shutdown script" --yesno "Do you have a MightyHat or ATXRaspi installed on this Pi?\nNote: the script will start running only after a reboot so make sure to your ATXRaspi is wired before next boot otherwise leaving the feedback GPIO7 floating can cause unexpected reboots/shutdown!" 8 78) then
  sudo wget https://raw.githubusercontent.com/LowPowerLab/ATX-Raspi/master/shutdownchecksetup.sh
  sudo bash shutdownchecksetup.sh && sudo rm shutdownchecksetup.sh
fi

#alternate way of console input:
#echo -e -n "Do you have a MightyHat or ATXRaspi installed? Type [Y/n] & [ENTER]: "
#read shutdownYN
# shutdownYN=$shutdownYN | xargs #trim
# if [ "$shutdownYN" == "Y" ] || [ "$shutdownYN" == "y" ]; then
  # sudo wget https://raw.githubusercontent.com/LowPowerLab/ATX-Raspi/master/shutdownchecksetup.sh
  # sudo bash shutdownchecksetup.sh && sudo rm shutdownchecksetup.sh
# fi


echo -e "${CYAN}************* STEP: Disable GPIO serial console *************${NC}"
sudo raspi-config nonint do_serial 1
# sudo wget https://raw.githubusercontent.com/lurch/rpi-serial-console/master/rpi-serial-console -O /usr/bin/rpi-serial-console && sudo chmod +x /usr/bin/rpi-serial-console
# if [[ "$(rpi-serial-console status | grep wheezy)" == *"enabled"* ]]; then
  # sudo rpi-serial-console disable
# fi

echo -e "${CYAN}************* STEP: Run raspi-config *************${NC}"
if (whiptail --title "Run raspi-config ?" --yesno "Would you like to run raspi-config?\n\Note: you should run this tool and configure the essential settings of your Pi if you haven't done it yet!" 8 78) then
  sudo raspi-config
fi

echo -e "${CYAN}************* STEP: Configuring logrotate *************${NC}"
sudo echo '#this is used by logrotate and should be placed in /etc/logrotate.d/
#rotate the gateway logs and keep a limit of how many are archived
#note: archives are rotated in /home/pi/gateway/logs so that dir must exist prior to rotation
/home/pi/gateway/logs/*.log {
        size 20M
        missingok
        rotate 20
        dateext
        dateformat -%Y-%m-%d
        compress
        notifempty
        nocreate
        copytruncate
}' > /etc/logrotate.d/gateway

echo -e "${CYAN}************* STEP: Setup Gateway service ... *************${NC}"
sudo cp /home/pi/gateway/_piConfigs/gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable gateway.service
sudo systemctl start gateway.service

echo -e "${RED}Make sure: ${YLW}to edit your gateway settings from the UI or from settings.json5 (and restart to apply changes)${NC}"
echo -e "${RED}By default ${YLW}the gateway app uses the GPIO serial port. If you use MoteinoUSB or another serial port you must edit the serial port setting or else the app will not receive messages from your Moteino nodes.${NC}"
echo -e "${RED}App restarts ${YLW}can be requested from the Gateway UI (power symbol button on settings page, or from the terminal via ${RED}sudo systemctl restart gateway.service${NC}"
echo -e "${RED}Don't forget: ${YLW}install proftpd (choose standalone mode) if you plan to FTP transfer files to your Pi (very useful!) with ${GRN}sudo apt-get install proftpd${NC}"
echo -e "${RED}Don't forget: ${YLW}install minicom - useful for serial port debugging with ${GRN}sudo apt-get install minicom${NC}"
echo -e "${RED}Adding users: ${YLW}You can run tool again to add more gateway users (skip all other steps, reboot when done)${NC}"
echo -e "${RED}! Important : ${YLW}If not done already - configure your Pi core settings (timezone, expand SD etc) by running ${GRN}raspi-config${NC}"

# echo -e "${CYAN}************* STEP: Run raspi-config *************${NC}"
# if (whiptail --title "Run raspi-config ?" --yesno "Would you like to run raspi-config now?\nNote: you should run this tool if you haven't done it yet!\nAlso: raspi-config allows a reboot after changes" 10 80) then
  # sleep 5
  # sudo raspi-config
# fi

echo -e "${CYAN}************* ALL DONE! *************${NC}"
cd ~/
exit 0