package market

import (
    "context"
    "sync"
)

type Collector struct {
    // ... existing fields ...
    mu sync.Mutex
    flushLoop *sync.WaitGroup
}

func (c *Collector) Start(ctx context.Context) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if c.flushLoop != nil {
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

    c.flushLoop.Wait()
    c.flushLoop = nil
}

func (c *Collector) Restart() {
    c.Stop()
    c.Start()
}