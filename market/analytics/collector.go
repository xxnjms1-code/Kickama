package market

import (
    "context"
    "sync"
)

type Collector struct {
    // ... existing fields ...
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

    c.flushChan = make(chan struct{})
    c.stopChan = make(chan struct{})

    go func() {
        for {
            select {
            case <-c.stopChan:
                return
            case <-c.flushChan:
                // flush logic here
            }
        }
    }()
}

func (c *Collector) Stop() {
    c.mu.Lock()
    if !c.stopped {
        close(c.stopChan)
        c.stopped = true
        c.mu.Unlock()
        return
    }
    c.mu.Unlock()
}

func (c *Collector) Restart() {
    c.Stop()
    c.Start(context.Background())
}