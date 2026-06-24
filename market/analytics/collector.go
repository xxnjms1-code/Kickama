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
    defer c.mu.Unlock()

    if !c.stopped {
        return
    }

    c.stopped = false
    c.flushChan = make(chan struct{}, 1)
    go func() {
        for {
            select {
            case <-c.flushChan:
                // flush logic here
            case <-ctx.Done():
                return
            }
        }
    }()
}

func (c *Collector) Stop() {
    c.mu.Lock()
    defer c.mu.Unlock()

    if c.stopped {
        return
    }

    c.stopped = true
    close(c.flushChan)
}

func (c *Collector) Restart() {
    c.Stop()
    c.Start(context.Background())
}