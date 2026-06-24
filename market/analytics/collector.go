package market

import (
    "context"
    "sync"
)

type collector struct {
    stopChan chan struct{}
    stopOnce sync.Once
    stopped bool
}

func (c *collector) Start(ctx context.Context) {
    c.stopOnce.Do(func() {
        c.stopChan = make(chan struct{})
        go c.flushLoop(ctx)
    })
}

func (c *collector) Stop() {
    c.stopOnce.Do(func() {
        close(c.stopChan)
        c.stopped = true
    })
}

func (c *collector) flushLoop(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case <-c.stopChan:
            return
        }
        // flush logic here
    }
}
