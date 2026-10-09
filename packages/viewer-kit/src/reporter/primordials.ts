export type ReporterWindow = Window & typeof globalThis
export function capturePrimordials(win: ReporterWindow) {
  const savedParent = win.parent
  const reflectApply = win.Reflect.apply
  const savedPostMessage: (
    receiver: Window,
    message: Record<string, unknown>,
    targetOrigin: string,
  ) => void = win.Function.prototype.call.bind(savedParent.postMessage)
  const savedAddEventListener = win.addEventListener.bind(win)
  const trustedGetter = win.Object.getOwnPropertyDescriptor(
    win.Event.prototype,
    'isTrusted',
  )
  const targetGetter = win.Object.getOwnPropertyDescriptor(
    win.Event.prototype,
    'target',
  )
  const defaultPreventedGetter = win.Object.getOwnPropertyDescriptor(
    win.Event.prototype,
    'defaultPrevented',
  )
  const persistedGetter = win.PageTransitionEvent
    ? win.Object.getOwnPropertyDescriptor(
        win.PageTransitionEvent.prototype,
        'persisted',
      )
    : undefined
  const buttonGetter = win.Object.getOwnPropertyDescriptor(
    win.MouseEvent.prototype,
    'button',
  )
  const metaKeyGetter = win.Object.getOwnPropertyDescriptor(
    win.MouseEvent.prototype,
    'metaKey',
  )
  const ctrlKeyGetter = win.Object.getOwnPropertyDescriptor(
    win.MouseEvent.prototype,
    'ctrlKey',
  )
  const shiftKeyGetter = win.Object.getOwnPropertyDescriptor(
    win.MouseEvent.prototype,
    'shiftKey',
  )
  const altKeyGetter = win.Object.getOwnPropertyDescriptor(
    win.MouseEvent.prototype,
    'altKey',
  )
  const trustedGet: ((event: Event) => boolean) | null =
    trustedGetter && trustedGetter.get
      ? win.Function.prototype.call.bind(trustedGetter.get)
      : null
  const targetGet: ((event: Event) => EventTarget | null) | null =
    targetGetter && targetGetter.get
      ? win.Function.prototype.call.bind(targetGetter.get)
      : null
  const defaultPreventedGet: ((event: Event) => boolean) | null =
    defaultPreventedGetter && defaultPreventedGetter.get
      ? win.Function.prototype.call.bind(defaultPreventedGetter.get)
      : null
  const persistedGet: ((event: Event) => boolean) | null =
    persistedGetter && persistedGetter.get
      ? win.Function.prototype.call.bind(persistedGetter.get)
      : null
  const buttonGet: ((event: Event) => number) | null =
    buttonGetter && buttonGetter.get
      ? win.Function.prototype.call.bind(buttonGetter.get)
      : null
  const metaKeyGet: ((event: Event) => boolean) | null =
    metaKeyGetter && metaKeyGetter.get
      ? win.Function.prototype.call.bind(metaKeyGetter.get)
      : null
  const ctrlKeyGet: ((event: Event) => boolean) | null =
    ctrlKeyGetter && ctrlKeyGetter.get
      ? win.Function.prototype.call.bind(ctrlKeyGetter.get)
      : null
  const shiftKeyGet: ((event: Event) => boolean) | null =
    shiftKeyGetter && shiftKeyGetter.get
      ? win.Function.prototype.call.bind(shiftKeyGetter.get)
      : null
  const altKeyGet: ((event: Event) => boolean) | null =
    altKeyGetter && altKeyGetter.get
      ? win.Function.prototype.call.bind(altKeyGetter.get)
      : null
  const preventDefault: (event: Event) => void =
    win.Function.prototype.call.bind(win.Event.prototype.preventDefault)
  const addEventListener: <K extends keyof WindowEventMap>(
    target: EventTarget,
    type: K,
    listener: (event: WindowEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void = win.Function.prototype.call.bind(
    win.EventTarget.prototype.addEventListener,
  )
  const rangeToString: (range: Range) => string =
    win.Function.prototype.call.bind(win.Range.prototype.toString)
  const arrayMap: <T, R>(
    array: ArrayLike<T>,
    callback: (value: T, index: number, array: ArrayLike<T>) => R,
  ) => R[] = win.Function.prototype.call.bind(win.Array.prototype.map)
  const weakMapDelete: <K extends WeakKey, V>(
    map: WeakMap<K, V>,
    key: K,
  ) => boolean = win.Function.prototype.call.bind(win.WeakMap.prototype.delete)
  const weakMapGet: <K extends WeakKey, V>(
    map: WeakMap<K, V>,
    key: K,
  ) => V | undefined = win.Function.prototype.call.bind(
    win.WeakMap.prototype.get,
  )
  const weakMapSet: <K extends WeakKey, V>(
    map: WeakMap<K, V>,
    key: K,
    value: V,
  ) => WeakMap<K, V> = win.Function.prototype.call.bind(
    win.WeakMap.prototype.set,
  )
  const defineProperty = win.Object.defineProperty
  const objectCreate = win.Object.create
  const objectKeys = win.Object.keys
  const closest: (element: Element, selector: string) => Element | null =
    win.Function.prototype.call.bind(win.Element.prototype.closest)
  const getAttribute: (element: Element, name: string) => string | null =
    win.Function.prototype.call.bind(win.Element.prototype.getAttribute)
  const hasAttribute: (element: Element, name: string) => boolean =
    win.Function.prototype.call.bind(win.Element.prototype.hasAttribute)
  return {
    savedParent,
    reflectApply,
    getPrototypeOf: win.Object.getPrototypeOf,
    savedPostMessage,
    savedAddEventListener,
    trustedGetter,
    targetGetter,
    defaultPreventedGetter,
    buttonGetter,
    metaKeyGetter,
    ctrlKeyGetter,
    shiftKeyGetter,
    altKeyGetter,
    trustedGet,
    targetGet,
    defaultPreventedGet,
    persistedGet,
    buttonGet,
    metaKeyGet,
    ctrlKeyGet,
    shiftKeyGet,
    altKeyGet,
    preventDefault,
    addEventListener,
    rangeToString,
    arrayMap,
    weakMapDelete,
    weakMapGet,
    weakMapSet,
    defineProperty,
    objectCreate,
    objectKeys,
    closest,
    getAttribute,
    hasAttribute,
  }
}
