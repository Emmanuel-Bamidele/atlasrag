//
//  tcp.js
//  mini_redis
//
//  Created by Emmanuel Bamidele on 2/11/26.
//

// tcp.js
// This file handles sending commands to the C++ TCP server.

const net = require("net");

// Hostname inside Docker network is the service name: "redis"
// If running locally without Docker, you can switch to "127.0.0.1"
const TCP_HOST = process.env.TCP_HOST || "redis";
const TCP_PORT = parseInt(process.env.TCP_PORT || "6379", 10);

// sendCmd sends ONE command and returns ONE line reply
function sendCmd(cmd) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();

    let data = "";

    client.connect(TCP_PORT, TCP_HOST, () => {
      client.write(cmd.trim() + "\n");
    });

    client.on("data", (chunk) => {
      data += chunk.toString();

      // Our C++ server replies with one line per command
      if (data.includes("\n")) {
        client.destroy();
        resolve(data.trim());
      }
    });

    client.on("error", reject);
  });
}

// Build a VSET command string
// id = string
// vec = array of floats
function buildVset(id, vec) {

  // dim = how many floats
  const dim = vec.length;

  // Convert floats to strings
  // toString() is okay for MVP; later we can control precision
  const floats = vec.map(x => x.toString()).join(" ");

  return `VSET ${id} ${dim} ${floats}`;
}

// Build a VSEARCH command string
function buildVsearch(k, vec) {
  const dim = vec.length;
  const floats = vec.map(x => x.toString()).join(" ");
  return `VSEARCH ${k} ${dim} ${floats}`;
}

// Parse VSEARCH reply:
// "id1 score1|id2 score2|id3 score3"
function parseVsearchReply(line) {
  if (!line) return [];

  // Split by "|"
  const items = line.split("|").map(x => x.trim()).filter(Boolean);

  const out = [];

  for (const item of items) {

    // item looks like: "doc#0 0.9234"
    const parts = item.split(/\s+/);

    if (parts.length < 2) continue;

    const id = parts[0];
    const score = parseFloat(parts[1]);

    out.push({ id, score });
  }

  return out;
}

module.exports = {
  sendCmd,
  buildVset,
  buildVsearch,
  parseVsearchReply
};
