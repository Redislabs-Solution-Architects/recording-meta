#!/bin/bash
# Usage: start.sh
# Description:  Starts a 3-node Redis Enterpise cluster + Nodejs app server.  Loads RE with synthetic
# contact center data.  Finally, executes a series of Search scenarios on that contact center data.

echo -e "\n*** Start 3 Redis Enterprise Nodes ***"
docker compose up -d

echo -e "\n*** Wait for Redis nodes to come on line ***"
curl -s -o /dev/null --retry 5 --retry-all-errors --retry-delay 3 -f -k -u "redis@redis.com:redis" https://localhost:19443/v1/bootstrap

echo -e "\n*** Build Redis Enterprise Cluster ***"
docker exec -it re1 /opt/redislabs/bin/rladmin cluster create name cluster.local username redis@redis.com password redis
docker exec -it re2 /opt/redislabs/bin/rladmin cluster join nodes 192.168.20.2 username redis@redis.com password redis
docker exec -it re3 /opt/redislabs/bin/rladmin cluster join nodes 192.168.20.2 username redis@redis.com password redis

echo -e "\n*** Build Database ***"
curl -s -o /dev/null -k -u "redis@redis.com:redis" https://localhost:19443/v1/bdbs -H "Content-Type:application/json" -d @db1.json
sleep 5

echo -e "\n*** Execute Nodejs App ***"
npm start