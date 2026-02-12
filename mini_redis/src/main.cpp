// Tell Asio we are NOT using Boost
#define ASIO_STANDALONE

#include <asio.hpp>     // Networking library
#include <iostream>    // std::cout
#include <sstream>     // std::istringstream
#include <string>      // std::string
#include <thread>      // std::thread
#include <vector>      // std::vector

#include "db.h"
#include "wal.h"

// Short alias
using asio::ip::tcp;

//
// Split "SET a 1" -> ["SET","a","1"]
//
static std::vector<std::string> split_words(const std::string& line) {

  std::vector<std::string> parts;

  // Treat string like input stream
  std::istringstream iss(line);

  std::string word;

  // Read space-separated words
  while (iss >> word) {
    parts.push_back(word);
  }

  return parts;
}

//
// Execute command and return reply
//
static std::string handle_command(
    const std::string& line,
    DB& db,
    WAL& wal) {

  auto parts = split_words(line);

  if (parts.empty()) return "";

  const std::string& cmd = parts[0];

  // SET key value
  if (cmd == "SET" && parts.size() == 3) {

    const std::string& key = parts[1];
    const std::string& val = parts[2];

    wal.append_line("SET " + key + " " + val);
    db.set(key, val);

    return "OK\n";
  }

  // GET key
  if (cmd == "GET" && parts.size() == 2) {

    const std::string& key = parts[1];
    auto v = db.get(key);

    if (v) return *v + "\n";
    return "(nil)\n";
  }

  // DEL key
  if (cmd == "DEL" && parts.size() == 2) {

    const std::string& key = parts[1];

    wal.append_line("DEL " + key);
    bool removed = db.del(key);

    return removed ? "1\n" : "0\n";
  }

  return "ERR unknown command\n";
}

//
// Load WAL file into DB on startup
//
static void replay_wal(DB& db, const WAL& wal) {

  for (const auto& line : wal.read_all_lines()) {

    auto parts = split_words(line);

    if (parts.size() == 3 && parts[0] == "SET") {
      db.set(parts[1], parts[2]);
    }
    else if (parts.size() == 2 && parts[0] == "DEL") {
      db.del(parts[1]);
    }
  }
}

//
// Runs in its own thread per client
//
static void client_thread(
    tcp::socket socket,
    DB& db,
    WAL& wal) {

  try {

    while (true) {

      asio::streambuf buffer;

      // Read until newline
      asio::read_until(socket, buffer, "\n");

      std::istream is(&buffer);
      std::string line;

      std::getline(is, line);

      // Remove '\r' if present
      if (!line.empty() && line.back() == '\r')
        line.pop_back();

      // Ignore empty lines
      if (line.empty())
        continue;

      std::string reply =
          handle_command(line, db, wal);

      if (!reply.empty()) {
        asio::write(socket,
                    asio::buffer(reply));
      }
    }
  }
  catch (...) {
    // Client disconnected
  }
}

//
// Program entry point
//
int main() {

  DB db;
  WAL wal("wal.log");

  replay_wal(db, wal);

  asio::io_context io;

  // Create listening socket on port 6379
  tcp::acceptor acceptor(
      io,
      tcp::endpoint(tcp::v4(), 6379));

  std::cout
      << "mini-redis listening on port 6379...\n";

  // Accept clients forever
  while (true) {

    tcp::socket socket(io);

    // Wait for client
    acceptor.accept(socket);

    std::cout << "Client connected\n";

    // Start thread for this client
    std::thread(
        client_thread,
        std::move(socket),
        std::ref(db),
        std::ref(wal)
    ).detach();
  }
}
