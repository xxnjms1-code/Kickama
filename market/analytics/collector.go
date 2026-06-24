package market

import (
    "context"
    "sync"
)

// Collector represents a market analytics collector.
type Collector struct {
    // ... existing fields ...
    stopChan chan struct{}
    flushChan chan struct{}
    stopped bool
    mu sync.Mutex
}

func (c *Collector) Start(ctx context.Context) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if c.stopped {
        return
    }

    if c.flushChan == nil {
        c.flushChan = make(chan struct{})
    }

    go func() {
        // ... existing flush logic ...
        close(c.flushChan)
    }()
}

func (c *Collector) Stop() {
    c.mu.Lock()
    defer c.mu.Unlock()

    if !c.stopped {
        close(c.flushChan)
        c.stopped = true
    }
}

func (c *Collector) Restart() {
    c.mu.Lock()
    defer c.mu.Unlock()

    if c.stopped {
        c.Start(context.Background())
    }
}