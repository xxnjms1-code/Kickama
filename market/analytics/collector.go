package market

import (
    "context"
    "sync"
)

type Collector struct {
    // ... existing fields ...
    flushLoop *sync.Once
    stopChan chan struct{}
}

func (c *Collector) Start(ctx context.Context) {
    c.flushLoop.Do(func() {
        // ... existing flush logic ...
        go func() {
            for {
                select {
                    case <-ctx.Done():
                        return
                    case <-c.stopChan:
                        return
                }
                // ... existing flush logic ...
            }
        }()
    })
}

func (c *Collector) Stop() {
    close(c.stopChan)
}

func (c *Collector) Restart() {
    c.Stop()
    c.Start(context.Background())
}