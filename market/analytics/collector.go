package market

import (
    "context"
    "sync"
)

type Collector struct {
    stopChan chan struct{}
    flushChan chan struct{}
    stopped bool
    mu sync.Mutex
}

func (c *Collector) Start(ctx context.Context) {
    c.mu.Lock()
    if c.stopped {
        c.mu.Unlock()
        return
    }
    c.mu.Unlock()

    c.stopChan = make(chan struct{})
    c.flushChan = make(chan struct{})

    go c.flushLoop(ctx)
}

func (c *Collector) Stop() {
    c.mu.Lock()
    if !c.stopped {
        close(c.stopChan)
        c.stopped = true
    }
    c.mu.Unlock()
}

func (c *Collector) flushLoop(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case <-c.stopChan:
            return
        case <-time.After(10 * time.Second):
            // flush logic here
        }
    }
}

func (c *Collector) restart() {
    c.mu.Lock()
    if !c.stopped {
        c.mu.Unlock()
        return
    }
    c.mu.Unlock()

    c.stopChan = make(chan struct{})
    c.flushChan = make(chan struct{})

    go c.flushLoop(context.Background())
}