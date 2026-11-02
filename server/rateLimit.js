/** Small dependency-free IP limiter for sensitive API routes. Use a shared store for multi-instance production. */
export function rateLimit({ windowMs = 60_000, max = 30 } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const current = buckets.get(key);
    const bucket = !current || now - current.startedAt >= windowMs ? { startedAt: now, count: 0 } : current;
    bucket.count += 1;
    buckets.set(key, bucket);
    if (bucket.count > max) return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    next();
  };
}
