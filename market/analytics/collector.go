package market

import (
    "context"
    "sync"
)

type Collector struct {
    // ... existing fields ...
    stopChan chan struct{}
    flushWG  sync.WaitGroup
}

func (c *Collector) Start(ctx context.Context) {
    if c.stopChan != nil { // check if already started
        return
    }
    c.stopChan = make(chan struct{})
    c.flushWG.Add(1)
    go c.flushLoop(ctx)
}

func (c *Collector) Stop() {
    if c.stopChan == nil { // check if already stopped
        return
    }
    close(c.stopChan)
    c.flushWG.Wait()
    c.flushWG.Done()
    c.stopChan = nil
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
