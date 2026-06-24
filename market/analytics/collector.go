package market

cache := make(map[string]*Collector)

func (c *Collector) Start(ctx context.Context) {
    if c == nil || c.stopped {
        return
    }

    if c.flushGoroutine != nil {
        return
    }

    c.flushGoroutine = &goroutineWrapper{
        func() {
            for {
                select {
                case <-ctx.Done():
                    return
                case <-c.flushSignal:
                    // flush logic here
                }
                // flush logic here
            }
        },
        func() {
            c.flushSignal = make(chan struct{})
        },
        func() {
            close(c.flushSignal)
        },
    }

    go c.flushGoroutine.Start()
}

func (c *Collector) Stop() {
    if c == nil || c.stopped {
        return
    }

    if c.flushGoroutine != nil {
        c.flushGoroutine.Stop()
        c.flushGoroutine = nil
    }

    c.stopped = true
}

func (c *Collector) Restart() {
    c.Stop()
    c.Start(context.Background())
}

type goroutineWrapper struct {
    start func()
    init func()
    stop func()
}

func (g *goroutineWrapper) Start() {
    g.init()
    go g.start()
}

func (g *goroutineWrapper) Stop() {
    g.stop()
}
