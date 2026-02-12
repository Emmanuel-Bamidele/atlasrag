//
//  vector_db.h
//  AtlasRAG
//
//  Created by Emmanuel Bamidele on 2/11/26.
//

#pragma once
// ^ "pragma once" prevents this header from being included multiple times in one build.

// -------------------------
// C++ standard library includes
// -------------------------
#include <algorithm>      // std::partial_sort, std::min
#include <cmath>          // std::sqrt
#include <shared_mutex>   // std::shared_mutex, std::unique_lock, std::shared_lock
#include <string>         // std::string
#include <unordered_map>  // std::unordered_map
#include <utility>        // std::pair
#include <vector>         // std::vector

// VectorDB = in-memory store for embeddings (vector<float>).
// It supports:
//  - add/update an embedding by id
//  - delete an embedding
//  - search top-k most similar vectors to a query vector (cosine similarity)
class VectorDB {
public:
  // Constructor: create an empty VectorDB
  VectorDB() = default;

  // -------------------------
  // add_or_update(id, vec)
  // -------------------------
  // "void" means this returns nothing.
  // "const std::string&" = reference to a string that we promise not to modify (fast: no copy).
  // "const std::vector<float>&" = reference to vector of floats (embedding), no copy.
  //
  // Returns: true if inserted new id, false if updated existing id.
  bool add_or_update(const std::string& id,
                     const std::vector<float>& vec)
  {
    // unique_lock = exclusive lock (only one writer at a time).
    std::unique_lock lock(mu_);

    // find existing id
    auto it = vectors_.find(id);

    // If not found, insert new
    if (it == vectors_.end()) {
      vectors_[id] = vec;   // copy vec into the map
      dims_ = (int)vec.size(); // remember the embedding dimension we are using
      return true;
    }

    // If found, update existing
    it->second = vec; // replace the stored vector
    return false;
  }

  // -------------------------
  // remove(id)
  // -------------------------
  // Returns: true if removed, false if id didn't exist.
  bool remove(const std::string& id)
  {
    std::unique_lock lock(mu_);

    // erase returns number of items erased (0 or 1)
    return vectors_.erase(id) > 0;
  }

  // -------------------------
  // size()
  // -------------------------
  // "std::size_t" is an unsigned integer type used for sizes.
  std::size_t size() const
  {
    // shared_lock = multiple readers can access at same time.
    std::shared_lock lock(mu_);
    return vectors_.size();
  }

  // -------------------------
  // dims()
  // -------------------------
  // returns the embedding dimension we are using (e.g. 1536).
  // returns 0 if empty (no vectors stored yet).
  int dims() const
  {
    std::shared_lock lock(mu_);
    return dims_;
  }

  // -------------------------
  // search(query, k)
  // -------------------------
  // query = embedding vector for the query text
  // k = number of results you want (top-k)
  //
  // Returns a vector of (id, score) pairs sorted by score descending.
  // score is cosine similarity (range approx -1..1).
  std::vector<std::pair<std::string, float>>
  search(const std::vector<float>& query, int k) const
  {
    std::shared_lock lock(mu_);

    // If empty database, return empty list
    if (vectors_.empty()) return {};

    // If query dimension doesn't match stored dimension, return empty
    // (We enforce "one dimension for all vectors" in MVP.)
    if ((int)query.size() != dims_) return {};

    // Precompute query norm (length)
    float qnorm = norm(query);
    if (qnorm == 0.0f) return {}; // avoid divide-by-zero

    // We'll compute similarity for every vector (brute-force scan).
    // This is fine for MVP (hundreds/thousands of vectors).
    std::vector<std::pair<std::string, float>> scores;
    scores.reserve(vectors_.size());

    // range-based for loop: "for (const auto& item : vectors_)"
    // "const auto&" means:
    //  - const: we won't modify item
    //  - auto: compiler figures out the type
    //  - &: reference to avoid copying
    for (const auto& item : vectors_) {

      const std::string& id = item.first;          // map key
      const std::vector<float>& vec = item.second; // map value

      float vnorm = norm(vec);
      if (vnorm == 0.0f) {
        // if vector has 0 length, similarity is 0
        scores.push_back({id, 0.0f});
        continue;
      }

      // cosine similarity = dot(query, vec) / (|query| * |vec|)
      float sim = dot(query, vec) / (qnorm * vnorm);

      scores.push_back({id, sim});
    }

    // If k is larger than size, reduce it
    if (k < 0) k = 0;
    if ((std::size_t)k > scores.size()) k = (int)scores.size();

    // partial_sort puts the top-k items in front in correct order,
    // without sorting the entire array (faster than full sort).
    std::partial_sort(
      scores.begin(),
      scores.begin() + k,
      scores.end(),
      [](const auto& a, const auto& b) {
        return a.second > b.second; // higher similarity first
      }
    );

    // resize to only keep top-k
    scores.resize(k);

    return scores;
  }

private:
  // -------------------------
  // dot(a, b)
  // -------------------------
  // dot product = sum(a[i] * b[i])
  static float dot(const std::vector<float>& a,
                   const std::vector<float>& b)
  {
    float s = 0.0f;

    // for loop: i from 0 to a.size()-1
    for (std::size_t i = 0; i < a.size(); ++i) {
      s += a[i] * b[i];
    }
    return s;
  }

  // -------------------------
  // norm(v)
  // -------------------------
  // norm = sqrt(sum(v[i]^2))
  static float norm(const std::vector<float>& v)
  {
    float s = 0.0f;

    for (float x : v) {
      s += x * x;
    }

    return std::sqrt(s);
  }

  // Mutex for thread safety.
  // "mutable" allows locking inside const functions like size() and search().
  mutable std::shared_mutex mu_;

  // The actual storage: id -> embedding vector
  std::unordered_map<std::string, std::vector<float>> vectors_;

  // Store the expected dimension (e.g. 1536).
  // We keep MVP simple: all vectors must have same dimension.
  int dims_ = 0;
};
