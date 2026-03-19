#pragma once
// Prevent multiple inclusion
#include <optional>        // std::optional
#include <shared_mutex>    // std::shared_mutex, std::unique_lock
#include <string>          // std::string
#include <unordered_map>   // std::unordered_map
#include <chrono>          // time types
#include <atomic>          // std::atomic

class DB {
public:
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

    std::unique_lock lock(mu_);

    // If expired -> delete and count it
    if (is_expired_nolock(key)) {
      kv_.erase(key);
      expirations_.erase(key);
      expired_removed_.fetch_add(1); // atomic increment
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

  // How many keys currently exist
  std::size_t size() const {
    std::unique_lock lock(mu_);   // lock because kv_ can change
    return kv_.size();
  }

  // How many expired keys have been removed since start
  long long expired_removed_count() const {
    return expired_removed_.load();
  }

private:
  bool is_expired_nolock(const std::string& key) {
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
