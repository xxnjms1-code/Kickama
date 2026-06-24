package market

import (
    "context"
    "sync"
)

type Collector struct {
    stopChan chan struct{}
    flushChan chan struct{}
    stopped bool
}

func (c *Collector) Start(ctx context.Context) {
    if c.stopped {
        c.stopped = false
        c.stopChan = make(chan struct{})
        c.flushChan = make(chan struct{})
    }
    go c.flushLoop(ctx)
}

func (c *Collector) Stop() {
    if !c.stopped {
        c.stopped = true
        close(c.flushChan)
    }
}

func (c *Collector) flushLoop(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case <-c.flushChan:
            // flush logic here
        }
        }
    }
}

func (c *Collector) restart() {
    c.Stop()
    c.Start()
}