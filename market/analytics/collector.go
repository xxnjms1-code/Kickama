package market

import (
    "context"
    "sync"
)

type Collector struct {
    // ... existing fields ...
    stopChan chan struct{}
    flushChan chan struct{}
    started bool
}

func (c *Collector) Start(ctx context.Context) {
    if c.started {
        return
    }
    c.started = true
    c.stopChan = make(chan struct{})
    c.flushChan = make(chan struct{})
    go c.flushLoop(ctx)
}

func (c *Collector) Stop() {
    close(c.stopChan)
}

func (c *Collector) flushLoop(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case <-c.stopChan:
            return
        case <-c.flushChan:
            // flush logic here
        }
    }
}

func (c *Collector) restart(ctx context.Context) {
    c.Stop()
    c.Start(ctx)
}