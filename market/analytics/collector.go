package market

import (
    "context"
    "sync"
)

// Collector represents an analytics collector.
type Collector struct {
    // ... existing fields ...
    mu sync.Mutex
    flushLoop *sync.WaitGroup
    stopped bool
}

func (c *Collector) Start(ctx context.Context) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if c.flushLoop != nil && !c.stopped {
        return
    }

    c.flushLoop = &sync.WaitGroup{}
    c.flushLoop.Add(1)
    go func() {
        defer c.flushLoop.Done()
        // ... existing flush logic ...
    }()
}

func (c *Collector) Stop() {
    c.mu.Lock()
    defer c.mu.Unlock()

    if c.flushLoop == nil {
        return
    }

    c.stopped = true
    c.flushLoop.Wait()
    c.flushLoop = nil
}

func (c *Collector) Restart() {
    c.Stop()
    c.Start()
}