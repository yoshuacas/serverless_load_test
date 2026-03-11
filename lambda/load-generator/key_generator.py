"""Key generators: uniform random and Zipfian (hot-key) distributions."""

import math
import random


class UniformKeyGenerator:
    """Generates keys uniformly across the key space."""

    def __init__(self, key_space_size: int, prefix: str = "k"):
        self.key_space_size = key_space_size
        self.prefix = prefix

    def next_key(self) -> str:
        idx = random.randint(0, self.key_space_size - 1)
        return f"{self.prefix}:{idx}"


class ZipfianKeyGenerator:
    """
    Generates keys following a Zipfian distribution.
    Top ~1% of keys receive ~80% of traffic (alpha=1.0).
    Higher alpha = more skewed (hotter hot keys).
    """

    def __init__(self, key_space_size: int, alpha: float = 1.0, prefix: str = "k"):
        self.key_space_size = key_space_size
        self.alpha = alpha
        self.prefix = prefix

        # Pre-compute the CDF for rejection-free sampling
        self._weights = [1.0 / math.pow(i + 1, alpha) for i in range(key_space_size)]
        self._total_weight = sum(self._weights)
        # Build cumulative distribution
        self._cumulative = []
        cumsum = 0.0
        for w in self._weights:
            cumsum += w / self._total_weight
            self._cumulative.append(cumsum)

    def next_key(self) -> str:
        # Binary search on cumulative distribution
        r = random.random()
        lo, hi = 0, self.key_space_size - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if self._cumulative[mid] < r:
                lo = mid + 1
            else:
                hi = mid
        return f"{self.prefix}:{lo}"


class SequentialKeyGenerator:
    """Generates unique sequential keys. Used for memory growth scenarios (no overwrites)."""

    def __init__(self, prefix: str = "seq"):
        self.prefix = prefix
        self._counter = 0

    def next_key(self) -> str:
        self._counter += 1
        return f"{self.prefix}:{self._counter}"


def create_key_generator(distribution: str, key_space_size: int):
    if distribution == "zipf":
        return ZipfianKeyGenerator(key_space_size, alpha=1.0)
    elif distribution == "sequential":
        return SequentialKeyGenerator()
    else:
        return UniformKeyGenerator(key_space_size)
