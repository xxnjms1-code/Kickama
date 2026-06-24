package market

import (
    "context"
    "sync"
)

type Collector struct {
    mu sync.Mutex
    started bool
    stopCh chan struct{}
    flushCh chan struct{}
}

func (c *Collector) Start(ctx context.Context) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if c.started {
        return
    }

    c.started = true
    c.stopCh = make(chan struct{})
    c.flushCh = make(chan struct{})

    go c.flushLoop(ctx)
}

func (c *Collector) Stop() {
    c.mu.Lock()
    defer c.mu.Unlock()

    if !c.started {
        return
    }

    close(c.stopCh)
    c.started = false
}

func (c *Collector) flushLoop(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case <-c.stopCh:
            return
        }
        // flush logic here
    }
}
