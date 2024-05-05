import { el } from '@elemaudio/core'
import WebAudioRenderer from '@elemaudio/web-renderer'
import type HydraInstance from 'hydra-synth'
import type { HydraSynth } from 'hydra-synth'
import _ from 'lodash'
import type p5 from 'p5'
import {
  Children,
  createContext,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react'
import regl from 'regl'
import invariant from 'tiny-invariant'
import * as twgl from 'twgl.js'
import { useEventListener } from '../src/dom'
import { useInvariantContext } from '../src/react'
import { defaultVert2D } from '../src/shaders/utilities'
import { Layer as LayerInstance } from '../src/webgl'

export type TopContextInfo<T extends Record<string, any>> = {
  time: Time
  elements: T
}
type AllowedChildren = React.ReactElement | React.ReactElement[]
type ParentProps<Props, Self, InternalProps> = Props & {
  name: string
  children?: AllowedChildren
  draw?: (
    self: Self,
    context: TopContextInfo<Record<string, any>>,
    internalProps: InternalProps
  ) => void
  setup?: (self: Self, context: Omit<TopContextInfo<Record<string, any>>, 'time'>) => InternalProps
  deps?: any[]
}

type ChildProps<Props, Self, Parent, InternalProps> = Props & {
  name: string
  draw?: (
    self: Self,
    parent: Parent,
    context: TopContextInfo<Record<string, any>>,
    internalProps: InternalProps
  ) => void
  setup?: (self: Self, parent: Parent, context: { elements: Record<string, any> }) => InternalProps
  deps?: any[]
}

type Time = { t: number; dt: number }

function useCreateComponent<Self, InternalProps>(
  name: string,
  getSelf: () => Self | Promise<Self>,
  options: Record<string, any>,
  setupSelf?: (
    self: Self,
    context: Omit<TopContextInfo<Record<string, any>>, 'time'>
  ) => InternalProps,
  drawSelf?: (
    self: Self,
    context: TopContextInfo<Record<string, any>>,
    props: InternalProps
  ) => void,
  drawSelfDeps?: any[],
  cleanupSelf?: (self: Self) => void
) {
  const { allCreated, registerComponent, elements } = useInvariantContext(
    TopLevelContext,
    'Need to nest under <Reactive> component'
  )

  const [self, setSelf] = useState<Self | null>(null)
  const creating = useRef(false)

  const asyncCreate = async () => {
    const self = await getSelf()
    setSelf(self)
    creating.current = false
  }

  const propsRef = useRef<InternalProps>(null!)

  const recreateDeps = Object.values(_.omit(options, 'name', 'setup', 'draw', 'children', 'deps'))
    .map((x) => x.toString())
    .join(';')

  useEffect(() => {
    if (!self) return
    registerComponent(name, {
      self,
      draw: drawSelf ? (context) => drawSelf(self, context, propsRef.current) : null,
      update: drawSelfDeps ? false : 'always'
    })
    return () => {
      registerComponent(name, null)
      if (cleanupSelf) {
        cleanupSelf(self)
      }
    }
  }, [self])

  useEffect(() => {
    if (creating.current) return
    creating.current = true
    asyncCreate()
    return
  }, [recreateDeps])

  useEffect(
    () => {
      if (!self || !drawSelfDeps) return

      registerComponent(name, {
        update: true
      })
    },
    !drawSelfDeps ? [] : drawSelfDeps
  )

  useEffect(() => {
    if (!self) return
    registerComponent(name, {
      draw: drawSelf ? (context) => drawSelf(self, context, propsRef.current) : null
    })
  }, [drawSelf])

  useEffect(() => {
    if (!self || !setupSelf || !allCreated) return
    propsRef.current = setupSelf(self, { elements })
  }, [allCreated])
  return { self }
}

type ComponentType = {
  draw: ((context: TopContextInfo<Record<string, any>>) => void) | null
  self: any
  update: 'always' | boolean
}

const TopLevelContext = createContext<{
  registerComponent: (name: string, component: Partial<ComponentType> | null) => void
  elements: Record<string, any>
  allCreated: boolean
} | null>(null)
const FrameContext = createContext<{
  frame: any
} | null>(null)

function TopLevelComponent({
  children,
  loop = true
}: {
  children?: AllowedChildren
  loop: boolean | number
}) {
  // the order to call draw calls in, using the key/string pairings from above
  let childrenDraws = useRef<string[]>([])
  // We have to save setups so that we know what hasn't been created yet. Every time a component calls registerComponent (on creation) this list is updated. Once the draw
  let childrenSetups = useRef<string[]>([])

  useEffect(() => {
    let drawCalls: any[] = []
    let setupCalls: any[] = []
    const childMap = (child: React.ReactElement) => {
      if (child.props.name) {
        setupCalls.push(child.props.name)
        if (child.props.draw) drawCalls.push(child.props.name)
        Children.forEach(child.props.children, (child) => childMap(child))
      }
    }
    Children.forEach(children, (child) => childMap(child!))
    childrenDraws.current = drawCalls
    childrenSetups.current = setupCalls
  })

  const [allCreated, setAllCreated] = useState(false)

  const components = useRef<Record<string, ComponentType>>({})
  // when allCreated is true elements get passed down as is (just to pass selves through)
  const elements = useRef<Record<string, any>>({})
  const registerComponent = (name: string, component: Partial<ComponentType> | null) => {
    if (component) {
      components.current[name] = { ...components.current[name], ...component }
      if (component.self) elements.current[name] = component.self
    } else {
      delete components.current[name]
      delete elements.current[name]
    }

    let allCreated = true
    for (let key of childrenSetups.current) {
      if (!components.current[key]) {
        allCreated = false
        break
      }
    }
    setAllCreated(allCreated)
  }

  const time = useRef(0)

  useEffect(() => {
    if (!allCreated) return
    let animationFrame: number
    let interval: number
    const drawFrame = (time: Time) => {
      const topContext = { time, elements: elements.current }
      for (let drawChild of childrenDraws.current) {
        const component = components.current[drawChild]
        invariant(component.draw, 'Missing draw call')
        // some components only draw on certain updates
        if (!component.update) continue
        component.draw!(topContext)
        if (component.update === true) {
          // turn off draw until the next update is requested
          component.update = false
        }
      }
    }
    if (loop === true) {
      const frameRequest: FrameRequestCallback = (t) => {
        drawFrame({ t, dt: t - time.current })
        time.current = t
        requestAnimationFrame(frameRequest)
      }

      requestAnimationFrame(frameRequest)
    } else if (typeof loop === 'number') {
      window.setInterval(() => {
        time.current += loop
        drawFrame({ t: time.current, dt: time.current - loop })
      }, loop)
    }
    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame)
      if (interval) window.clearInterval(interval)
    }
  }, [allCreated, loop, components])

  return (
    <TopLevelContext.Provider
      value={{
        allCreated,
        registerComponent,
        elements: elements.current
      }}
    >
      {children}
    </TopLevelContext.Provider>
  )
}

function FrameComponent<Self, Options, InternalProps>({
  options,
  getSelf,
  cleanupSelf,
  children
}: { options: ParentProps<Options, Self, InternalProps> } & {
  getSelf: (options: Options) => Self | Promise<Self>
  cleanupSelf?: (self: Self) => void
  children?: ParentProps<Options, Self, InternalProps>['children']
}) {
  const { self } = useCreateComponent(
    options.name,
    async () => await getSelf(options),
    options,
    options.setup,
    options.draw,
    options.deps,
    cleanupSelf
  )

  return (
    <FrameContext.Provider
      value={{
        frame: self
      }}
    >
      {self && children}
    </FrameContext.Provider>
  )
}

const ChildComponent = <Self, Options, Context, InternalProps>({
  options,
  getSelf,
  cleanupSelf
}: {
  options: ChildProps<Options, Self, Context, InternalProps>
} & {
  getSelf: (options: Options, context: Context) => Self | Promise<Self>
  cleanupSelf?: (self: Self) => void
}) => {
  const { frame } = useInvariantContext(FrameContext)
  useCreateComponent(
    options.name,
    async () => await getSelf(options, frame),
    options,
    options.setup ? (self, context) => options.setup!(self, frame, context) : undefined,
    options.draw
      ? (self, context, internalProps) => options.draw!(self, frame, context, internalProps)
      : undefined,
    options.deps,
    cleanupSelf
  )
  return <></>
}

type CanvasComponentProps = {
  className?: string
  width?: number
  height?: number
  id?: string
  resize?: boolean
  hidden?: boolean
}
const extractCanvasProps = (
  props: CanvasComponentProps & Record<string, any>
): CanvasComponentProps => {
  return {
    resize: true,
    ..._.pick(props, 'className', 'width', 'height', 'id', 'resize', 'hidden')
  }
}
const CanvasComponent = forwardRef<HTMLCanvasElement, CanvasComponentProps>((props, ref) => {
  const innerRef = useRef<HTMLCanvasElement>(
    props.hidden ? document.createElement('canvas') : null!
  )
  if (props.hidden) {
    innerRef.current.height = props.height ?? 1080
    innerRef.current.width = props.width ?? 1080
  }
  useImperativeHandle(ref, () => innerRef.current)
  const resizeCanvas = () => {
    const { width, height } = innerRef.current.getBoundingClientRect()
    innerRef.current.width = width
    innerRef.current.height = height
  }
  useEventListener('resize', () => {
    if (!props.resize || props.hidden) return
    resizeCanvas()
  })
  useEffect(() => {
    if (!props.resize || props.hidden) return
    resizeCanvas()
  }, [])

  return (
    <>
      {!props.hidden && (
        <canvas
          ref={innerRef}
          className={props.className ?? undefined}
          id={props.id}
          height={props.height}
          width={props.width}
        ></canvas>
      )}
    </>
  )
})

const components = {
  AudioCtx: <InternalProps,>(
    props: ParentProps<ConstructorParameters<typeof AudioContext>[0], AudioContext, InternalProps>
  ) => (
    <FrameComponent
      options={_.omit(props, 'children')}
      children={props.children}
      getSelf={(options?: ConstructorParameters<typeof AudioContext>[0] | undefined) =>
        new AudioContext(options)
      }
    />
  ),
  CanvasGL: <InternalProps,>(
    props: ParentProps<
      Omit<CanvasComponentProps, 'type'> & {
        glOptions?: WebGLContextAttributes
      },
      WebGL2RenderingContext,
      InternalProps
    >
  ) => {
    const canvasRef = useRef<HTMLCanvasElement>(null!)
    return (
      <>
        <CanvasComponent ref={canvasRef} {...extractCanvasProps(props)} />
        <FrameComponent
          options={_.omit(props, 'children')}
          children={props.children}
          getSelf={(options) => {
            const gl = canvasRef.current.getContext('webgl2', options.glOptions)!
            return gl
          }}
        />
      </>
    )
  },

  Canvas2D: <InternalProps,>(
    props: ParentProps<
      React.PropsWithChildren &
        CanvasComponentProps & { options?: CanvasRenderingContext2DSettings },
      CanvasRenderingContext2D,
      InternalProps
    >
  ) => {
    const canvasRef = useRef<HTMLCanvasElement>(null!)
    return (
      <>
        <CanvasComponent ref={canvasRef} {...extractCanvasProps(props)} />
        <FrameComponent
          options={_.omit(props, 'children')}
          children={props.children}
          getSelf={(options) => {
            const gl = canvasRef.current.getContext('2d', props.options)!
            return gl
          }}
        />
      </>
    )
  },
  Regl: <InternalProps,>(
    props: ParentProps<
      CanvasComponentProps & {
        options?: regl.InitializationOptions
      },
      { regl: regl.Regl },
      InternalProps
    >
  ) => {
    const canvasRef = useRef<HTMLCanvasElement>(null!)
    return (
      <>
        <CanvasComponent ref={canvasRef} {...extractCanvasProps({ ...props, type: 'webgl2' })} />
        <FrameComponent
          options={_.omit(props, 'children')}
          children={props.children}
          getSelf={(options) => {
            const gl = canvasRef.current.getContext('webgl2')!
            return { regl: regl({ gl, ...options.options }) }
          }}
          cleanupSelf={(self) => self.regl.destroy()}
        />
      </>
    )
  },
  Processing: <InternalProps,>(
    props: ParentProps<
      CanvasComponentProps & {
        type: 'p2d' | 'webgl'
      },
      p5,
      InternalProps
    >
  ) => {
    const canvasRef = useRef<HTMLCanvasElement>(null!)
    return (
      <>
        <CanvasComponent ref={canvasRef} {...extractCanvasProps(props)} />
        <FrameComponent
          options={_.omit(props, 'children')}
          children={props.children}
          getSelf={async (options) => {
            const p5 = await import('p5')

            return new p5.default((p: p5) => {
              // disable draw and setup, they get handled in the previous contexts
              p.setup = () => {
                p.noLoop()
                p.createCanvas(
                  canvasRef.current.height,
                  canvasRef.current.width,
                  options.type,
                  canvasRef.current
                )
              }
            })
          }}
        />
      </>
    )
  },
  Hydra: <InternalProps,>(
    props: ParentProps<
      CanvasComponentProps &
        ConstructorParameters<typeof HydraInstance>[0] & {
          hideCanvas?: true
        },
      HydraSynth,
      InternalProps
    >
  ) => {
    const canvasRef = useRef<HTMLCanvasElement>(null!)
    return (
      <>
        <CanvasComponent ref={canvasRef} {...extractCanvasProps(props)} />
        <FrameComponent
          options={_.omit(props, 'children')}
          children={props.children}
          getSelf={async (options) => {
            const { default: HydraInstance } = await import('hydra-synth')

            const instance = new HydraInstance({
              makeGlobal: false,
              autoLoop: false,
              detectAudio: true,
              width: canvasRef.current.width,
              height: canvasRef.current.height,
              canvas: canvasRef.current,
              ...options
            })
            return instance.synth
          }}
        ></FrameComponent>
      </>
    )
  },
  CameraInput: <InternalProps,>(
    props: ParentProps<
      React.PropsWithChildren & { width: number; height: number },
      HTMLVideoElement,
      InternalProps
    >
  ) => {
    const videoRef = useRef<HTMLVideoElement>(document.createElement('video'))
    return (
      <>
        <FrameComponent
          options={_.omit(props, 'children')}
          children={props.children}
          getSelf={async (options) => {
            videoRef.current.height = props.height
            videoRef.current.width = props.width
            navigator.mediaDevices.getUserMedia({ video: true }).then((localMediaStream) => {
              videoRef.current.srcObject = localMediaStream
            })
            await videoRef.current.play()
            return videoRef.current
          }}
          cleanupSelf={(self) => self.remove()}
        />
      </>
    )
  }
}
const childComponents = {
  Texture: <InternalProps,>(
    props: ChildProps<
      Parameters<(typeof twgl)['createTexture']>[1],
      WebGLTexture,
      WebGL2RenderingContext,
      InternalProps
    >
  ) => (
    <ChildComponent
      options={props}
      getSelf={(options, context) => {
        return twgl.createTexture(context, {
          height: context.canvas.height,
          width: context.canvas.width,
          ...options
        })
      }}
    />
  ),
  Mesh: <InternalProps,>(
    props: ChildProps<
      Omit<ConstructorParameters<typeof LayerInstance>[0], 'gl'>,
      LayerInstance,
      WebGL2RenderingContext,
      InternalProps
    >
  ) => (
    <ChildComponent
      options={props}
      getSelf={async (options, context) => {
        return new LayerInstance({ ...options, gl: context })
      }}
    />
  ),
  /**
   * Returns a Mesh with positions at each of the four corners, only requiring code for a fragment shader.
   */
  Plane: <InternalProps,>(
    props: ChildProps<
      Omit<ConstructorParameters<typeof LayerInstance>[0], 'gl' | 'attributes' | 'vertexShader'>,
      LayerInstance,
      WebGL2RenderingContext,
      InternalProps
    >
  ) => (
    <ChildComponent
      options={props}
      getSelf={async (options, context) => {
        return new LayerInstance({
          ...options,
          attributes: {
            position: {
              data: [-1, 1, 1, 1, -1, -1, 1, -1],
              numComponents: 2
            }
          },
          vertexShader: defaultVert2D,
          fragmentShader: `in vec2 uv;\n` + options.fragmentShader,
          drawMode: 'triangle strip',
          gl: context
        })
      }}
    />
  ),
  /**
   * Returns a Layer alowing a fragment shader from a `sampler2D canvas` which is set to the canvas on each draw call.
   */
  GLFilter: <InternalProps,>(
    props: ChildProps<
      Omit<ConstructorParameters<typeof LayerInstance>[0], 'gl' | 'attributes' | 'vertexShader'>,
      { filter: (uniforms?: Record<string, any>) => void },
      WebGL2RenderingContext,
      InternalProps
    >
  ) => (
    <ChildComponent
      options={props}
      getSelf={async (options, context) => {
        const texture = context.createTexture()!
        twgl.resizeTexture(context, texture, {
          width: context.drawingBufferWidth,
          height: context.drawingBufferHeight
        })
        const layer = new LayerInstance({
          ...options,
          attributes: {
            position: {
              data: [-1, 1, 1, 1, -1, -1, 1, -1],
              numComponents: 2
            }
          },
          vertexShader: defaultVert2D,
          fragmentShader: `uniform sampler2D canvas;\nin vec2 uv;\n` + options.fragmentShader,
          drawMode: 'triangle strip',
          gl: context
        })

        return {
          filter: (uniforms) => {
            twgl.resizeTexture(context, texture, {
              width: context.drawingBufferWidth,
              height: context.drawingBufferHeight
            })
            twgl.setTextureFromElement(context, texture, context.canvas as HTMLCanvasElement)
            layer.draw({ ...uniforms, canvas: texture })
          }
        }
      }}
    />
  ),
  Elementary: <InternalProps,>(
    props: ChildProps<
      Parameters<WebAudioRenderer['initialize']>[1],
      { node: AudioWorkletNode; core: WebAudioRenderer; el: typeof el },
      AudioContext,
      InternalProps
    >
  ) => (
    <ChildComponent
      options={props}
      getSelf={async (options, context) => {
        const core = new WebAudioRenderer()
        let node = await core.initialize(context, options)
        return { node, core, el }
      }}
    />
  ),
  MicInput: <InternalProps,>(
    props: ChildProps<
      {},
      {
        input: MediaStreamAudioSourceNode
        gain: GainNode
        compressor: DynamicsCompressorNode
      },
      AudioContext,
      InternalProps
    >
  ) => (
    <ChildComponent
      options={props}
      getSelf={async (options, context) => {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true
        })
        const input = context.createMediaStreamSource(stream)
        const gain = context.createGain()
        const compressor = context.createDynamicsCompressor()
        input.connect(compressor)
        compressor.connect(gain)
        return { input, gain, compressor }
      }}
    />
  ),
  BufferSource: <InternalProps,>(
    props: ChildProps<
      {
        source?: AudioBufferSourceOptions
        buffer?: AudioBufferOptions
        url?: string
        data?: number[][]
      },
      { source: AudioBufferSourceNode; buffer: AudioBuffer },
      AudioContext,
      InternalProps
    >
  ) => (
    <ChildComponent
      options={props}
      getSelf={async (options, context) => {
        let buffer: AudioBuffer
        if (options?.url) {
          const data = await fetch(options.url)
          buffer = await context.decodeAudioData(await data.arrayBuffer())
        } else if (options?.data) {
          buffer = new AudioBuffer({
            length: options.data[0].length,
            numberOfChannels: options.data.length,
            sampleRate: context.sampleRate
          })
          for (let i = 0; i < options.data.length; i++)
            [buffer.copyToChannel(new Float32Array(options.data[i]), i)]
        } else {
          buffer = new AudioBuffer({
            length: 1000,
            numberOfChannels: 1,
            sampleRate: context.sampleRate,
            ...options.buffer
          })
        }
        return { source: new AudioBufferSourceNode(context, { ...options.source, buffer }), buffer }
      }}
    />
  )
}

// Libraries that don't play well on the same canvas, etc. (often Canvas)
export const AudioCtx = components.AudioCtx
export const CanvasGL = components.CanvasGL
export const Canvas2D = components.Canvas2D
export const Hydra = components.Hydra
export const Regl = components.Regl
export const Processing = components.Processing
export const CameraInput = components.CameraInput

// Libraries embedded within a certain one (often AudioContext nodes)
export const Texture = childComponents.Texture
export const Elementary = childComponents.Elementary
export const MicInput = childComponents.MicInput
export const Mesh = childComponents.Mesh
export const Plane = childComponents.Plane
export const GLFilter = childComponents.GLFilter
export const BufferSource = childComponents.BufferSource

export const Reactive = TopLevelComponent