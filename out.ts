import { fabric } from "fabric";
import { penDevices, SelectionMode } from "../../../const";
import { repositionRelativeElementsEvent } from "../../../features/canvas/shared/RelativeToCanvasObject";
import { defaultProjectColor } from "../../../features/users/users.utils";
import { selectUserProfile } from "../../../reduxStore/auth/auth.reducer";
import { CanvasMode, selectCanvasMode } from "../../../reduxStore/canvas/app/app.reducer";
import { getInitialInkState } from "../../../reduxStore/canvas/drawing/drawing.reducer";
import { selectActivatePenOnTouch, selectCanvasGrid, selectEmbedTransparency, selectObjectGradients } from "../../../reduxStore/canvas/userSettings/userSettings.reducer";
import { selectVotingSession, VotingState } from "../../../reduxStore/canvas/voting/voting.reducer";
import { reduxSingleton } from "../../../reduxStore/redux.singleton";
import { getDevicePixelRatio } from "../../../tools";
import debounce from "../../../tools/debounce";
import { ApiPermission } from "../../../types/enum";
import { hasInnerObjects, isActiveSelection } from "../../utils/fabricObjects";
import { CanvasLineManager } from "../line/canvasLineManager";
import { removeAlignmentLines } from "../patches/extends-auto-alignment/auto-alignment.utils";

/** @TODO Move most of the properties and methods away from this module to a better separate one */
export interface BaseCollaboardCanvas {
  __prevObjectsOrder?: fabric.Object[];
  activeChatUuid?: string; // TODO: #5927 remove - single source of truth
  permission: ApiPermission; // TODO: #5927 remove - single source of truth
  myself: string; // TODO: #5927 remove - single source of truth
  mode: Readonly<CanvasMode>; // TODO: #5927 remove - single source of truth
  projectColor: string; // TODO: #5927 remove - single source of truth
  projectId: string; // TODO: #5927 remove - single source of truth
  isGridEnabled: boolean;
  isUserInactive: boolean; // TODO #5927: remove - single source of truth
  isPresentationMode: boolean; // TODO #5927: remove - single source of truth
  signalRConnected: boolean; // TODO #5927: remove - single source of truth
  /** @TODO #7104 - Match these with the canvasMode */
  isObjectSelectionMode: boolean; // TODO #5927: remove - single source of truth
  isEyeDropperActive: boolean; // TODO #5927: remove - single source of truth
  isViewOnlyMode: boolean; // TODO #5927: remove - single source of truth
  selectionMode: SelectionMode;
  votingSessionState?: Readonly<VotingState>; // TODO: #5927 - remove (single source of truth)

  // Settings
  activatePenOnTouch: boolean;
  embedTransparency: boolean;
  enableObjectGradients: boolean;
  backgroundColor: string;
  disposingHook: Promise<void>;
  isMouseDown?: boolean;
  matchMediaEventHandlers: Array<{
    mql: MediaQueryList;
    handler: () => void;
  }>;
  pixelRatio: number;
  tempLocked?: fabric.Object[];
  windowEventHandlers: Record<string, (event: Event) => void>;
  _onMouseDown(e: PointerEvent): void;
  _onMouseUp(e: PointerEvent): void;
  initialize(el: HTMLCanvasElement, options: Partial<fabric.CollaboardCanvas>): void;
  destroy(this: fabric.CollaboardCanvas): void;
  attachCustomEvents(): void;
  attachDOMEventHandlers(): void;
  attachMatchMediaEventHandlers(): void;
  onCanvasResize(): void;
  onDevicePixelRatioChange: () => void;
  disposeDOMEventHandlers(): void;
  reinitialize(): void;
  requestRepositionRelativeElements: () => void;
  saveObjectsOrder(): void;
  restoreObjectsOrder(): void;
  triggerDisposingHook(): void;
  isPermissionReadOnly(): boolean;
  isFacilitator(): boolean;
}
const mixin: Partial<BaseCollaboardCanvas & fabric.Canvas> = {
  renderOnAddRemove = false;,
  uniScaleKey = "none";,
  permission = ApiPermission.noPermission;,
  isViewOnlyMode = false;,
  // TODO: #5927 - remove (single source of truth)
  projectColor = defaultProjectColor;,
  initialize(this: fabric.CollaboardCanvas, el: HTMLCanvasElement, options: Partial<fabric.CollaboardCanvas>) {
    const state = reduxSingleton.getStore().getState();
    const activatePenOnTouch = selectActivatePenOnTouch(state);
    const embedTransparency = selectEmbedTransparency(state);
    const enableObjectGradients = selectObjectGradients(state);
    const isGridEnabled = selectCanvasGrid(state);
    const finalOptions = {
      ...options,
      targetFindTolerance = 10;,
      enablePointerEvents = true;,
      width = window.innerWidth;,
      height = window.innerHeight;,
      stopContextMenu = true;,
      urlsClickable = true;,
      selectionFullyContained = true;,
      embedTransparency = embedTransparency;,
      enableObjectGradients = enableObjectGradients;,
      activatePenOnTouch = activatePenOnTouch;,
      isGridEnabled = isGridEnabled;
    };

    // in case that pen touch can activate drawing we need some initial values
    this.inkState = getInitialInkState();
    this.callSuper("initialize", el, finalOptions);
    this.mode = selectCanvasMode(state); // TODO: #5927 - remove (single source of truth)
    this.myself = selectUserProfile(state)?.UserName || "";

    /**
     * Create a promise that is resolved when the canvas is disposed.
     * This can be used by objects to cancel in-flights network requests.
     */
    this.disposingHook = new Promise(resolve => {
      this.triggerDisposingHook = resolve;
    });
    this.pixelRatio = getDevicePixelRatio();
    this.attachCanvasGestures();
    this.attachHoverEvents();

    // set center in screen coordinate system
    this.viewportTransform[4] = this.width / 2;
    this.viewportTransform[5] = this.height / 2;
    this.initializeObjectsMap();

    // initialization of variable if we are in the middle of pinch or wheel events
    this.__isPinchOrWheelInProgress = false;
    this.__prevCanvasZoom = this.getZoom();

    // TODO: temporary - don't bring to front on select
    // this.preserveObjectStacking = true;

    this.lineManager = new CanvasLineManager(this);

    // reset brush, it will be created later depends on user action (toolbar, pen-touch, etc)
    this.freeDrawingBrush = null;
    this.requestRepositionRelativeElements = debounce(() => document.dispatchEvent(new CustomEvent(repositionRelativeElementsEvent)));
    this.votingSessionState = selectVotingSession(state); // TODO: #5927 - remove (single source of truth)
    this.initializeAnimations();
    this.initializeHelp();
    this.initializeMousePositions();
    this.initializeMouseWheel();
    this.initializePanOnSpacebar();
    this.initializePendingCopies();
    this.initializeReservations();
    this.initializeSelectionMode();
    this.attachCustomEvents();
    this.attachDOMEventHandlers();
    this.attachMatchMediaEventHandlers();
    this.updateColorScheme();
  },
  /**
   * Reset and reinitialize the canvas.
   *
   * @NOTE Ensure only methods with safe side-effects are called, e.g. avoid calling methods which attach
   * event handlers.
   */
  reinitialize(this: fabric.CollaboardCanvas) {
    this.clear();

    // Reinitialize the objects UUID map after the canvas has been cleared, to avoid incorrectly detecting
    // the canvas objects as missing in the UUID map because of the internal `.discardActiveObject()` in `.clear()`
    this.initializeObjectsMap();
    this.initializeMousePositions();
    this.initializePendingCopies();
    this.initializeReservations();
  },
  attachCustomEvents(this: fabric.CollaboardCanvas) {
    this.on("mouse:dblclick", this.onMouseDoubleClick);
    this.on("object:rotating", function ({
      target = target;
    }) {
      hasInnerObjects(target) && target.onRotating();
    });
    this.on("object:rotated", function ({
      target = target;
    }) {
      hasInnerObjects(target) && target.onRotated();
    });
    this.on("object:scaling", function ({
      target = target;
    }) {
      hasInnerObjects(target) && target.onScaling();
    });
    this.on("object:scaled", function ({
      target = target;
    }) {
      hasInnerObjects(target) && target.onScaled();
    });
    this.on("object:moving", function ({
      target = target;
    }) {
      hasInnerObjects(target) && target.onMoving();
    });
    this.on("object:moved", function ({
      target = target;
    }) {
      hasInnerObjects(target) && target.onMoved();
    });
    this.on("before:transform", ({
      transform = transform;
    }) => {
      if (!transform) {
        return;
      }
      const {
        target = target;,
        action = action;
      } = transform;
      if (["rotate", "scale", "drag", "move"].includes(action) && isActiveSelection(target)) {
        const locked = target.getObjects().filter(o => o.isLocked());
        this.tempLocked = locked;

        // Remove locked objects just before transforming active selection.
        // This way we are transforming only the unlocked objects.
        locked.forEach(o => {
          target._restoreObjectState(o);
          target.remove(o);
        });
      }
    });
    this.on("after:transform", ({
      transform = transform;
    }) => {
      const object = transform?.target;
      if (this.tempLocked && object && hasInnerObjects(object)) {
        // Restore temporarily removed locked objects by adding them
        // to the active selection.
        this.tempLocked.forEach(o => object.addWithUpdate(o));
        delete this.tempLocked;
      }
    });
    this.on("object:moving", function ({
      target = target;
    }) {
      this.activateSnapping(target);
    });
    this.on("object:moved", function () {
      removeAlignmentLines(this);
      this.recreateGroups();
    });
    this.on("object:removed", function () {
      removeAlignmentLines(this);
    });
    this.on("custom:objects:removed", function () {
      removeAlignmentLines(this);
    });
    this._attachDrawingModeEventHandlers();
    this.on("custom:canvas:set:urls:clickable", function ({
      urlsClickable = urlsClickable;
    }) {
      this.urlsClickable = urlsClickable;
    });
  },
  saveObjectsOrder(this: fabric.CollaboardCanvas) {
    this.__prevObjectsOrder = this.getObjects();
  },
  restoreObjectsOrder(this: fabric.CollaboardCanvas) {
    if (!this.__prevObjectsOrder) {
      return;
    }
    this._objects = [...this.__prevObjectsOrder];
    delete this.__prevObjectsOrder;
  },
  isPermissionReadOnly(this: fabric.CollaboardCanvas) {
    return this.permission === ApiPermission.readPermission;
  },
  isFacilitator(this: fabric.CollaboardCanvas) {
    return this.permission >= ApiPermission.facilitatorPermission;
  },
  // in normal use case (when user choose draw mode from toolbar)
  // _onMouseDownInDrawingMode method is called when pen/mouse touch canvas
  // in 'pen-touch to activate drawing' case it's oposite direction
  // canvas first know and activate drawing, and propagate this to
  // also we need to have knowledge what is current setup of drawing tool
  _onMouseDown(this: fabric.CollaboardCanvas, e: PointerEvent) {
    this.isMouseDown = true;
    if (
    /**
     * Put conditions here to prevent calling fabric's _onMouseDown and `__onMouseDown`. Possible reasons are:
     * - prevent registering canvas "mouse:up" event is registered in `_onMouseDown`
     * - prevent selection being updated or discarded on `__onMouseDown`
     * - (?)
     */
    this.isDrawingMode && this._isCurrentlyDrawing) {
      // Ignore additional mousedown events when user is currently drawing.
      // This can happen if user taps with another finger while drawing.
      return;
    }

    // Store the pointerId so we can ignore additional touches
    this._drawingPointerId = e.pointerId;
    if (this.activatePenOnTouch && penDevices.includes(e.pointerType)) {
      this.trigger("custom:canvas:stylus:down");
    }
    this.callSuper("_onMouseDown", e);
  },
  _onMouseUp(this: fabric.CollaboardCanvas, e: PointerEvent) {
    this.isMouseDown = false;
    if (this.isSelectingArea) {
      this.discardActiveObject();
    }
    this.callSuper("_onMouseUp", e);
  },
  // ***************************************************************************
  // resize canvas
  onCanvasResize(this: fabric.CollaboardCanvas) {
    this.setHeight(window.innerHeight);
    this.setWidth(window.innerWidth);
    this.calcOffset();
    this.trigger("custom:canvas:resized");
    this.renderAll(); // not `requestRenderAll` (cypress snapshots fail)
  },
  onDevicePixelRatioChange(this: fabric.CollaboardCanvas) {
    this.pixelRatio = getDevicePixelRatio();
    this.trigger("custom:devicePixelRatio:change");
  },
  /**
   * Attach DOM event handlers
   */
  attachDOMEventHandlers(this: fabric.CollaboardCanvas) {
    this.windowEventHandlers = {
      resize = this.onCanvasResize.bind(this);,
      paste = (this.onPaste.bind(this) as (event: Event) => void);
    };
    Object.entries(this.windowEventHandlers).forEach(([eventName, eventHandler]) => {
      window.addEventListener(eventName, eventHandler);
    });
  },
  /**
   * Destroy DOM event handlers
   */
  disposeDOMEventHandlers(this: fabric.CollaboardCanvas) {
    Object.entries(this.windowEventHandlers).forEach(([eventName, eventHandler]) => {
      window.removeEventListener(eventName, eventHandler);
    });
  },
  /**
   * Attach matchMedia event handlers
   */
  attachMatchMediaEventHandlers(this: fabric.CollaboardCanvas) {
    this.matchMediaEventHandlers = window.matchMedia ? [{
      mql = window.matchMedia("screen and (min-resolution: 2dppx)");,
      handler = this.onDevicePixelRatioChange.bind(this);
    }] : [];
    this.matchMediaEventHandlers.forEach(({
      mql = mql;,
      handler = handler;
    }) => {
      try {
        mql.addEventListener("change", handler);
      } catch (e) {
        // Compatibility with Safari < 14
        mql.addListener(handler);
      }
    });
  },
  /**
   * Destroy matchMedia event handlers
   */
  // disposeMatchMediaEventHandlers(this: fabric.CollaboardCanvas) {
  //   this.matchMediaEventHandlers.forEach(({ mql, handler }) => {
  //     try {
  //       mql.removeEventListener("change", handler);
  //     } catch (e) {
  //       // Compatibility with Safari < 14
  //       mql.removeListener(handler);
  //     }
  //   });
  // },
  /**
   * Destroy the canvas and inform objects.
   */
  destroy(this: fabric.CollaboardCanvas) {
    this.triggerDisposingHook();
    this.disposeDOMEventHandlers();
    this.disposePanOnSpacebar();
    this.disposeMouseWheel();
    this.disposeMousePositions();
    this.dispose();
    this.removeAllTemporaryDomElements();
  },
  /**
   * Fabric's default toJSON implementation correctly serializes only a subset of properties but
   * it may result in recursive call stack exception if the `.canvas` property is also serialized by
   * mistake, e.g. the fabric.Object was copied using a spread.
   *
   * @NOTE This is also called by the Redux devtools since we dispatch ON_CANVAS_ENTER with the canvas
   * reference.
   */
  toJSON() {
    return "serialized canvas";
  }
};
fabric.CollaboardCanvas = fabric.util.createClass(fabric.Canvas);