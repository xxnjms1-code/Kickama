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
    if c.flushChan == nil {
        c.flushChan = make(chan struct{})
    }
    go func() {
        select {
        case <-ctx.Done():
            return
        case <-c.flushChan:
            // flush logic here
        }
        c.stopChan <- struct{}{}
    }()
    c.mu.Unlock()
}

func (c *Collector) Stop() {
    c.mu.Lock()
    if c.stopped {
        c.mu.Unlock()
        return
    }
    close(c.flushChan)
    c.stopped = true
    c.mu.Unlock()
}

func (c *Collector) Restart() {
    c.Stop()
    c.Start(context.Background())
}