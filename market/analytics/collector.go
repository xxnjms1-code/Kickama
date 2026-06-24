package market

import (
    "context"
    "sync"
)

type Collector struct {
    // ... existing fields ...
    mu sync.Mutex
    flushLoop *sync.WaitGroup
    stopped bool
}

func (c *Collector) Start(ctx context.Context) {
    c.mu.Lock()
    if c.flushLoop != nil && !c.stopped {
        return
    }
    c.flushLoop = &sync.WaitGroup{}
    c.flushLoop.Add(1)
    go func() {
        defer c.flushLoop.Done()
        // ... existing flush logic ...
    }()
    c.mu.Unlock()
}

func (c *Collector) Stop() {
    c.mu.Lock()
    if c.flushLoop != nil {
        c.flushLoop.Done()
        c.flushLoop = nil
    }
    c.mu.Unlock()
}

func (c *Collector) Restart() {
    c.Stop()
    c.Start()
}