#pragma once
// Prevent multiple inclusion

#include <fstream>   // file input/output
#include <mutex>     // std::mutex, std::lock_guard
#include <string>    // std::string
#include <vector>    // std::vector

// WAL = Write-Ahead Log
// Stores every change so data survives crashes
class WAL {

public:

  // Constructor
  // explicit prevents accidental conversions
  explicit WAL(const std::string& path)
      : path_(path) {}   // store filename

  // Append one command line to log file
  void append_line(const std::string& line) {

    // lock_guard locks mutex when created,
    // and unlocks automatically when function exits
    std::lock_guard<std::mutex> guard(mu_);

    // Open file in append mode
    std::ofstream out(path_, std::ios::app);

    if (!out.is_open()) return;

    out << line << "\n";   // write command
    out.flush();           // force write to disk
  }

  // Read entire WAL file
  std::vector<std::string> read_all_lines() const {

    std::vector<std::string> lines;

    std::ifstream in(path_);
    if (!in.is_open()) return lines;

    std::string line;

    // Read file line-by-line
    while (std::getline(in, line)) {
      if (!line.empty()) {
        lines.push_back(line);
      }
    }

    return lines;
  }

private:

  std::string path_;   // filename of WAL

  // Protects file writes from multiple threads
  mutable std::mutex mu_;
};
