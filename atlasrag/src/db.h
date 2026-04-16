#pragma once
// Prevent multiple inclusion
#include <atomic>          // std::atomic
#include <chrono>          // time types
#include <optional>        // std::optional
#include <shared_mutex>    // std::shared_mutex, std::shared_lock, std::unique_lock
#include <string>          // std::string
#include <unordered_map>   // std::unordered_map
#include <vector>          // std::vector

class DB {
public:
  struct SnapshotEntry {
    std::string key;
    std::string value;
    std::optional<int> ttl_seconds;
  };

  void set(const std::string& key,
           const std::string& value) {

    std::unique_lock lock(mu_);
    kv_[key] = value;
    expirations_.erase(key); // remove TTL if any
  }

  void set_with_ttl(const std::string& key,
                    const std::string& value,
                    int ttl_seconds) {

    std::unique_lock lock(mu_);
    kv_[key] = value;

    auto expire_time =
      std::chrono::steady_clock::now() +
      std::chrono::seconds(ttl_seconds);

    expirations_[key] = expire_time;
  }

  std::optional<std::string> get(const std::string& key) {

    std::shared_lock lock(mu_);

    if (is_expired_nolock(key)) {
      return std::nullopt;
    }

    auto it = kv_.find(key);
    if (it == kv_.end()) return std::nullopt;

    return it->second;
  }

  bool del(const std::string& key) {
    std::unique_lock lock(mu_);
    expirations_.erase(key);
    return kv_.erase(key) > 0;
  }

  // Deletes expired keys; called by background thread
  void cleanup_expired() {
    std::unique_lock lock(mu_);

    for (auto it = expirations_.begin();
         it != expirations_.end();) {

      if (std::chrono::steady_clock::now() > it->second) {
        kv_.erase(it->first);
        it = expirations_.erase(it);
        expired_removed_.fetch_add(1);
      } else {
        ++it;
      }
    }
  }

  // Build a consistent snapshot of the current string state.
  // TTL entries are encoded as remaining seconds so the WAL can be compacted
  // without dropping active expirations.
  std::vector<SnapshotEntry> snapshot() {
    std::unique_lock lock(mu_);

    std::vector<SnapshotEntry> entries;
    entries.reserve(kv_.size());

    const auto now = std::chrono::steady_clock::now();

    for (auto it = kv_.begin(); it != kv_.end();) {
      auto exp_it = expirations_.find(it->first);

      if (exp_it != expirations_.end() && now > exp_it->second) {
        expirations_.erase(exp_it);
        it = kv_.erase(it);
        expired_removed_.fetch_add(1);
        continue;
      }

      SnapshotEntry entry{it->first, it->second, std::nullopt};

      if (exp_it != expirations_.end()) {
        auto remaining = std::chrono::duration_cast<std::chrono::seconds>(exp_it->second - now);
        int ttl = (int)remaining.count();
        if (ttl <= 0) ttl = 1;
        entry.ttl_seconds = ttl;
      }

      entries.push_back(entry);
      ++it;
    }

    return entries;
  }

  // How many keys currently exist
  std::size_t size() const {
    std::shared_lock lock(mu_);
    return kv_.size();
  }

  // How many expired keys have been removed since start
  long long expired_removed_count() const {
    return expired_removed_.load();
  }

private:
  bool is_expired_nolock(const std::string& key) const {
    auto it = expirations_.find(key);
    if (it == expirations_.end()) return false;
    return std::chrono::steady_clock::now() > it->second;
  }

  mutable std::shared_mutex mu_;

  std::unordered_map<std::string, std::string> kv_;
  std::unordered_map<std::string, std::chrono::steady_clock::time_point> expirations_;

  // Atomic counter = safe to increment from multiple threads
  std::atomic<long long> expired_removed_{0};
};
