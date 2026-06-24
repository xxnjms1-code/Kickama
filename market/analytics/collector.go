package market

import (
    "context"
    "sync"
)

// Collector represents a market analytics collector.
type Collector struct {
    // ... existing fields ...
    stopChan chan struct{}
    started bool
    flushWG sync.WaitGroup
}

func (c *Collector) Start(ctx context.Context) {
    if c.started {
        return
    }
    c.started = true
    c.stopChan = make(chan struct{})
    c.flushWG.Add(1)
    go c.flushLoop(ctx)
}

func (c *Collector) Stop() {
    close(c.stopChan)
    c.flushWG.Wait()
    c.flushWG.Done()
    c.started = false
}

func (c *Collector) flushLoop(ctx context.Context) {
    defer c.flushWG.Done()
    for {
        select {
        case <-ctx.Done():
            return
        case <-c.stopChan:
            return
        }
        // ... existing flush logic ...
    }
}
