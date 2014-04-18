var Fiber = require('fibers')

// Takes function and returns its synchronized version, it's still backward compatible and
// can be used as asynchronous `syncFn = sync(asyncFn)`.
//
// Or You can provide object and it will synchronize its functions `sync(obj, fname1, fname2, ...)`.
//
// New synchronized version of function is backward compatible and You may call it as usual with
// explicit callback or inside of `fiber` with `aware` and `defer` keywords.
var sync = module.exports = function(){
  if(arguments.length > 1){
    // Synchronizing functions of object.
    var obj = arguments[0]
    for(var i = 1; i < arguments.length; i++){
      var fname = arguments[i]
      var fn = obj[fname]
      if(!fn) throw new Error("object doesn't have '" + fname + "' function!")
      obj[fname] = sync(fn)
    }
  }else{
    return sync.syncFn(arguments[0])
  }
}

// Sometimes `Fiber` needed outside of `sync`.
sync.Fiber = Fiber

// Takes function and returns its synchronized version, it's still backward compatible and can
// be used as asynchronous.
sync.syncFn = function(fn){
  // Preventing function to be synchronized twice.
  if(fn._synchronized) return fn

  var syncFn = function(){
    // Using fibers only if there's active fiber and callback not provided explicitly.
    if(Fiber.current && (typeof arguments[arguments.length-1] !== 'function')){
      // Calling asynchronous function with our special fiber-aware callback.
      Array.prototype.push.call(arguments, sync.defer())
      fn.apply(this, arguments)

      // Waiting for asynchronous result.
      return sync.await()
    }else{
      // If there's no active fiber or callback provided explicitly we call original version.
      return fn.apply(this, arguments)
    }
  }

  // Marking function as synchronized.
  syncFn._synchronized = true

  return syncFn
}
// Use it to wait for asynchronous callback.
sync.await = Fiber.yield

// Creates fiber-aware asynchronous callback resuming current fiber when it will be finished.
sync.defer = function(){
  if(!Fiber.current) throw new Error("no current Fiber, defer can'b be used without Fiber!")
  if(Fiber.current._syncParallel)
    return sync.deferParallel()
  else
    return sync.deferSerial()
}

// Exactly the same as defer, but additionally it triggers an error if there's no response
// on time.
sync.deferWithTimeout = function(timeout){
  if(!timeout) throw new Error("no timeout provided!")
  var defer = this.defer()

  var called = false
  var d = setTimeout(function(){
    if(called) return
    called = true
    defer(new Error("defer timed out!"))
  }, timeout)

  return function(){
    if(called) return
    called = true
    clearTimeout(d)
    return defer.apply(this, arguments)
  }
}

//
sync.deferSerial = function(){
  var fiber = Fiber.current
  if(!fiber) throw new Error("no current Fiber, defer can'b be used without Fiber!")

  // Returning asynchronous callback.
  return function(err, result){
    // Wrapping in nextTick as a safe measure against not asynchronous usage.
    process.nextTick(function(){
      if(err){
        // Resuming fiber and throwing error.
        fiber.throwInto(err)
      }else{
        // Resuming fiber and returning result.
        fiber.run(result)
      }
    })
  }
}

sync.deferParallel = function(){
  var fiber = Fiber.current
  if(!fiber) throw new Error("no current Fiber, defer can'b be used without Fiber!")
  if(!fiber._syncParallel) throw new Error("invalid usage, should be called in parallel mode!")
  var data = fiber._syncParallel

  // Counting amount of `defer` calls.
  data.called += 1
  var resultIndex = data.called - 1

  // Returning asynchronous callback.
  return function(err, result){
    // Wrapping in nextTick as a safe measure against not asynchronous usage.
    process.nextTick(function(){
      if(err){
        // Resuming fiber and throwing error.
        fiber.throwInto(err)
      }else{
        data.returned += 1
        data.results[resultIndex] = result
        // Resuming fiber and returning result when all callbacks finished.
        if(data.returned == data.called) fiber.run(data.results)
      }
    })
  }
}

sync.defers = function(){
  if(!Fiber.current) throw new Error("no current Fiber, defer can'b be used without Fiber!")
  if(Fiber.current._syncParallel)
    return sync.defersParallel.apply(sync, arguments)
  else
    return sync.defersSerial.apply(sync, arguments)
}

sync.defersSerial = function(){
  var fiber = Fiber.current;
  if(!fiber) throw new Error("no current Fiber, defer can'b be used without Fiber!")

  var kwds = Array.prototype.slice.call(arguments)
  // Returning asynchronous callback.
  return function(err) {
    // Wrapping in nextTick as a safe measure against not asynchronous usage.
    var args = Array.prototype.slice.call(arguments, 1)
    process.nextTick(function(){
      if (err) {
        // Resuming fiber and throwing error.
        fiber.throwInto(err)
      }
      var results;
      if(!kwds.length){
        results = args
      } else {
        results = {}
        kwds.forEach(function(kwd, i){
          results[kwd]=args[i]
        })
      }
      fiber.run(results)
    })
  }
}

sync.defersParallel = function(){
  var fiber = Fiber.current
  if(!fiber) throw new Error("no current Fiber, defer can'b be used without Fiber!")
  if(!fiber._syncParallel) throw new Error("invalid usage, should be called in parallel mode!")
  var data = fiber._syncParallel
  // Counting amount of `defer` calls.
  data.called += 1
  var resultIndex = data.called - 1

  var kwds = Array.prototype.slice.call(arguments)
  // Returning asynchronous callback.
  return function(err) {
    // Wrapping in nextTick as a safe measure against not asynchronous usage.
    var args = Array.prototype.slice.call(arguments, 1)
    process.nextTick(function(){
      if (err) {
        // Resuming fiber and throwing error.
        fiber.throwInto(err)
      }
      var results;
      if(!kwds.length){
        results = args
      } else {
        results = {}
        kwds.forEach(function(kwd, i){
          results[kwd]=args[i]
        })
      }
      data.returned += 1
      data.results[resultIndex] = results
      if(data.returned == data.called) fiber.run(data.results)
    })
  }
}

// Support for parallel calls, all `defer` calls within callback will be
// performed in parallel.
sync.parallel = function(cb){
  var fiber = Fiber.current
  if(!fiber) throw new Error("no current Fiber, defer can'b be used without Fiber!")

  // Enabling `defer` calls to be performed in parallel.
  fiber._syncParallel = {called: 0, returned: 0, results: []}
  cb.call(this)
  delete fiber._syncParallel
}

// Executes `cb` within `Fiber`, when it finish it will call `done` callback.
// If error will be thrown during execution, this error will be catched and passed to `done`,
// if `done` not provided it will be just rethrown.
sync.fiber = function(cb, done){
  var that = this
  Fiber(function(){
    if (done) {
      try {
        var result = cb.call(that)
        done(null, result)
      } catch (error){
        done(error)
      }
    } else {
      // Don't catch errors if done not provided!
      cb.call(that)
    }
  }).run()
}

// Asynchronous wrapper for mocha.js tests.
//
//   async = sync.asyncIt
//   it('should pass', async(function(){
//     ...
//   }))
//
sync.asyncIt = function(cb){
  if(!cb) throw "no callback for async spec helper!"
  return function(done){sync.fiber(cb.bind(this), done)}
}

// Same as `sync` but with verbose logging for every method invocation.
// Ignore this method, it shouldn't be used unless you want to track down
// tricky and complex bugs and need full information abouth how and when all
// this async stuff has been called.
var fiberIdCounter = 1
sync.syncWithDebug = function(){
  if(arguments.length > 1){
    // Synchronizing functions of object.
    var obj = arguments[0]
    for(var i = 1; i < arguments.length; i++){
      (function(fname){
        var fn = obj[fname]
        if(!fn) throw new Error("object doesn't have '" + fname + "' function!")
        var syncedFn = sync(fn)
        obj[fname] = function(){
          if(Fiber.current && Fiber.current._fiberId == undefined){
            Fiber.current._fiberId = fiberIdCounter
            fiberIdCounter = fiberIdCounter + 1
            Fiber.current._callbackLevel = 0
          }

          var fiberId = '-'
          if(Fiber.current){
            fiberId = Fiber.current._fiberId
            Fiber.current._callbackLevel = Fiber.current._callbackLevel + 1
          }

          var indent = '    '
          if(Fiber.current)
            for(var j = 0; j < Fiber.current._callbackLevel; j++) indent = indent + '  '

          console.log(fiberId + indent + this.constructor.name + '.'
            + fname + " called", JSON.stringify(arguments))

          var result
          try{
            result = syncedFn.apply(this, arguments)
          }finally{
            console.log(fiberId + indent + this.constructor.name + '.'
              + fname + " finished")

            if(Fiber.current)
              Fiber.current._callbackLevel = Fiber.current._callbackLevel - 1
          }
          return result
        }
      })(arguments[i])
    }
  }else{
    return sync.syncFn(arguments[0])
  }
}