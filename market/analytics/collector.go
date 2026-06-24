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

    go func() {
        defer func()
        {
            c.mu.Lock()
            c.stopped = true
            close(c.stopChan)
            c.mu.Unlock()
        }()

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
        close(c.flushChan)
    }
    c.mu.Unlock()
}

func (c *Collector) Restart() {
    c.Stop()
    c.Start()
}