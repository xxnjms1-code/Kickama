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

    if c.stopped {
        return
    }

    if c.flushChan == nil {
        c.flushChan = make(chan struct{})
    }

    go func() {
        for {
            select {
            case <-ctx.Done():
                return
            case <-c.flushChan:
                // flush logic here
            }
        }
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
    c.Stop()
    c.Start(context.Background())
}