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
    c.stopChan = make(chan struct{})
    c.flushChan = make(chan struct{})

    go func() {
        defer func()
        select {
        case <-ctx.Done():
            return
        case <-c.stopChan:
            return
        }
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
    close(c.stopChan)
}

func (c *Collector) Restart() {
    c.Stop()
    c.Start(context.Background())
}