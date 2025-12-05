export declare class CanvasRenderer {
    private canvas;
    private ctx;
    private fontSize;
    private fontFamily;
    private cursorStyle;
    private cursorBlink;
    private theme;
    private devicePixelRatio;
    private metrics;
    private palette;
    private cursorVisible;
    private cursorBlinkInterval?;
    private lastCursorPosition;
    private lastViewportY;
    private selectionManager?;
    private hoveredHyperlinkId;
    private previousHoveredHyperlinkId;
    private hoveredLinkRange;
    private previousHoveredLinkRange;
    constructor(canvas: HTMLCanvasElement, options?: RendererOptions);
    private measureFont;
    /**
     * Remeasure font metrics (call after font loads or changes)
     */
    remeasureFont(): void;
    private rgbToCSS;
    /**
     * Resize canvas to fit terminal dimensions
     */
    resize(cols: number, rows: number): void;
    /**
     * Render the terminal buffer to canvas
     */
    render(buffer: IRenderable, forceAll?: boolean, viewportY?: number, scrollbackProvider?: IScrollbackProvider, scrollbarOpacity?: number): void;
    /**
     * Render a single line
     */
    private renderLine;
    /**
     * Render a single cell
     */
    private renderCell;
    /**
     * Render cursor
     */
    private renderCursor;
    private startCursorBlink;
    private stopCursorBlink;
    /**
     * Update theme colors
     */
    setTheme(theme: ITheme): void;
    /**
     * Update font size
     */
    setFontSize(size: number): void;
    /**
     * Update font family
     */
    setFontFamily(family: string): void;
    /**
     * Update cursor style
     */
    setCursorStyle(style: 'block' | 'underline' | 'bar'): void;
    /**
     * Enable/disable cursor blinking
     */
    setCursorBlink(enabled: boolean): void;
    /**
     * Get current font metrics
     */
    /**
     * Render scrollbar (Phase 2)
     * Shows scroll position and allows click/drag interaction
     * @param opacity Opacity level (0-1) for fade in/out effect
     */
    private renderScrollbar;
    getMetrics(): FontMetrics;
    /**
     * Get canvas element (needed by SelectionManager)
     */
    getCanvas(): HTMLCanvasElement;
    /**
     * Set selection manager (for rendering selection overlay)
     */
    setSelectionManager(manager: SelectionManager): void;
    /**
     * Set the currently hovered hyperlink ID for rendering underlines
     */
    setHoveredHyperlinkId(hyperlinkId: number): void;
    /**
     * Set the currently hovered link range for rendering underlines (for regex-detected URLs)
     * Pass null to clear the hover state
     */
    setHoveredLinkRange(range: {
        startX: number;
        startY: number;
        endX: number;
        endY: number;
    } | null): void;
    /**
     * Get character cell width (for coordinate conversion)
     */
    get charWidth(): number;
    /**
     * Get character cell height (for coordinate conversion)
     */
    get charHeight(): number;
    /**
     * Clear entire canvas
     */
    clear(): void;
    /**
     * Render selection overlay
     */
    private renderSelection;
    /**
     * Cleanup resources
     */
    dispose(): void;
}

/**
 * Cell style flags (bitfield)
 */
export declare enum CellFlags {
    BOLD = 1,
    ITALIC = 2,
    UNDERLINE = 4,
    STRIKETHROUGH = 8,
    INVERSE = 16,
    INVISIBLE = 32,
    BLINK = 64,
    FAINT = 128
}

/**
 * Cursor position and visibility
 */
export declare interface Cursor {
    x: number;
    y: number;
    visible: boolean;
}

export declare class EventEmitter<T> {
    private listeners;
    fire(arg: T): void;
    event: IEvent<T>;
    dispose(): void;
}

export declare class FitAddon implements ITerminalAddon {
    private _terminal?;
    private _resizeObserver?;
    private _resizeDebounceTimer?;
    private _lastCols?;
    private _lastRows?;
    private _isResizing;
    /**
     * Activate the addon (called by Terminal.loadAddon)
     */
    activate(terminal: ITerminalCore): void;
    /**
     * Dispose the addon and clean up resources
     */
    dispose(): void;
    /**
     * Fit the terminal to its container
     *
     * Calculates optimal dimensions and resizes the terminal.
     * Does nothing if dimensions cannot be calculated or haven't changed.
     */
    fit(): void;
    /**
     * Propose dimensions to fit the terminal to its container
     *
     * Calculates cols and rows based on:
     * - Terminal container element dimensions (clientWidth/Height)
     * - Terminal element padding
     * - Font metrics (character cell size)
     * - Scrollbar width reservation
     *
     * @returns Proposed dimensions or undefined if cannot calculate
     */
    proposeDimensions(): ITerminalDimensions | undefined;
    /**
     * Observe the terminal's container for resize events
     *
     * Sets up a ResizeObserver to automatically call fit() when the
     * container size changes. Resize events are debounced to avoid
     * excessive calls during window drag operations.
     *
     * Call dispose() to stop observing.
     */
    observeResize(): void;
}

export declare interface FontMetrics {
    width: number;
    height: number;
    baseline: number;
}

/* Excluded from this release type: getGhostty */

/**
 * Main Ghostty WASM wrapper class
 */
export declare class Ghostty {
    private exports;
    private memory;
    constructor(wasmInstance: WebAssembly.Instance);
    /**
     * Get current memory buffer (may change when memory grows)
     */
    private getBuffer;
    /**
     * Create a key encoder instance
     */
    createKeyEncoder(): KeyEncoder;
    /**
     * Create a terminal emulator instance
     */
    createTerminal(cols?: number, rows?: number, config?: GhosttyTerminalConfig): GhosttyTerminal;
    /**
     * Load Ghostty WASM from URL or file path
     * If no path is provided, attempts to load from common default locations
     */
    static load(wasmPath?: string): Promise<Ghostty>;
}

/**
 * Cell structure matching ghostty_cell_t in C (16 bytes)
 */
export declare interface GhosttyCell {
    codepoint: number;
    fg_r: number;
    fg_g: number;
    fg_b: number;
    bg_r: number;
    bg_g: number;
    bg_b: number;
    flags: number;
    width: number;
    hyperlink_id: number;
}

/**
 * GhosttyTerminal - Wraps the WASM terminal emulator
 *
 * Provides a TypeScript-friendly interface to Ghostty's complete
 * terminal implementation via WASM.
 *
 * @example
 * ```typescript
 * const ghostty = await Ghostty.load('./ghostty-vt.wasm');
 * const term = ghostty.createTerminal(80, 24);
 *
 * term.write('Hello\x1b[31m Red\x1b[0m\n');
 * const cursor = term.getCursor();
 * const cells = term.getLine(0);
 *
 * term.free();
 * ```
 */
export declare class GhosttyTerminal {
    private exports;
    private memory;
    private handle;
    private _cols;
    private _rows;
    /**
     * Size of ghostty_cell_t in bytes (16 bytes in WASM)
     * Structure: codepoint(u32) + fg_rgb(3xu8) + bg_rgb(3xu8) + flags(u8) + width(u8) + hyperlink_id(u16) + padding(u32)
     */
    private static readonly CELL_SIZE;
    /**
     * Create a new terminal.
     *
     * @param exports WASM exports
     * @param memory WASM memory
     * @param cols Number of columns (default: 80)
     * @param rows Number of rows (default: 24)
     * @param config Optional terminal configuration (colors, scrollback)
     * @throws Error if allocation fails
     */
    constructor(exports: GhosttyWasmExports, memory: WebAssembly.Memory, cols?: number, rows?: number, config?: GhosttyTerminalConfig);
    /**
     * Free the terminal. Must be called to prevent memory leaks.
     */
    free(): void;
    /**
     * Write data to terminal (parses VT sequences and updates screen).
     *
     * @param data UTF-8 string or Uint8Array
     *
     * @example
     * ```typescript
     * term.write('Hello, World!\n');
     * term.write('\x1b[1;31mBold Red\x1b[0m\n');
     * term.write(new Uint8Array([0x1b, 0x5b, 0x41])); // Up arrow
     * ```
     */
    write(data: string | Uint8Array): void;
    /**
     * Resize the terminal.
     *
     * @param cols New column count
     * @param rows New row count
     */
    resize(cols: number, rows: number): void;
    /**
     * Get terminal dimensions.
     */
    get cols(): number;
    get rows(): number;
    /**
     * Get terminal dimensions (for IRenderable compatibility)
     */
    getDimensions(): {
        cols: number;
        rows: number;
    };
    /**
     * Get cursor position and visibility.
     */
    getCursor(): Cursor;
    /**
     * Get scrollback length (number of lines in history).
     */
    getScrollbackLength(): number;
    /**
     * Check if terminal is in alternate screen buffer mode.
     *
     * The alternate screen is used by vim, less, htop, etc.
     * When active, normal buffer is preserved and restored when the app exits.
     *
     * @returns true if in alternate screen, false if in normal screen
     *
     * @example
     * ```typescript
     * // Detect if vim is running
     * if (term.isAlternateScreen()) {
     *   console.log('Full-screen app is active');
     * }
     * ```
     */
    isAlternateScreen(): boolean;
    /**
     * Check if a row is wrapped from the previous row.
     *
     * Wrapped rows are continuations of long lines that exceeded terminal width.
     * Used for text selection to treat wrapped lines as single logical lines.
     *
     * @param row Row index (0 = top visible line)
     * @returns true if row continues from previous line, false otherwise
     *
     * @example
     * ```typescript
     * // Get full logical line including wraps
     * let text = '';
     * for (let row = 0; row < term.rows; row++) {
     *   const line = term.getLine(row);
     *   text += lineToString(line);
     *
     *   // Only add newline if NOT wrapped
     *   if (!term.isRowWrapped(row + 1)) {
     *     text += '\n';
     *   }
     * }
     * ```
     */
    isRowWrapped(row: number): boolean;
    /**
     * Get a line of cells from the visible screen.
     *
     * @param y Line number (0 = top visible line)
     * @returns Array of cells, or null if y is out of bounds
     *
     * @example
     * ```typescript
     * const cells = term.getLine(0);
     * if (cells) {
     *   for (const cell of cells) {
     *     const char = String.fromCodePoint(cell.codepoint);
     *     const isBold = (cell.flags & CellFlags.BOLD) !== 0;
     *     console.log(`"${char}" ${isBold ? 'bold' : 'normal'}`);
     *   }
     * }
     * ```
     */
    getLine(y: number): GhosttyCell[] | null;
    /**
     * Get a line from scrollback history.
     *
     * @param offset Line offset from top of scrollback (0 = oldest line)
     * @returns Array of cells, or null if not available
     */
    getScrollbackLine(offset: number): GhosttyCell[] | null;
    /**
     * Check if any part of the screen is dirty.
     */
    isDirty(): boolean;
    /**
     * Check if a specific row is dirty.
     */
    isRowDirty(y: number): boolean;
    /**
     * Clear all dirty flags (call after rendering).
     */
    clearDirty(): void;
    /**
     * Get all visible lines at once (convenience method).
     *
     * @returns Array of line arrays, or empty array on error
     */
    getAllLines(): GhosttyCell[][];
    /**
     * Get only the dirty lines (for optimized rendering).
     *
     * @returns Map of row number to cell array
     */
    getDirtyLines(): Map<number, GhosttyCell[]>;
    /**
     * Get hyperlink URI by ID
     *
     * @param hyperlinkId Hyperlink ID from a GhosttyCell (0 = no link)
     * @returns URI string or null if ID is invalid/not found
     */
    getHyperlinkUri(hyperlinkId: number): string | null;
    /**
     * Query terminal mode state
     */
    getMode(mode: number, isAnsi?: boolean): boolean;
    /**
     * Check if bracketed paste mode is enabled
     */
    hasBracketedPaste(): boolean;
    /**
     * Check if focus event reporting is enabled
     */
    hasFocusEvents(): boolean;
    /**
     * Check if mouse tracking is enabled
     */
    hasMouseTracking(): boolean;
}

/**
 * Terminal configuration for WASM.
 * All colors use 0xRRGGBB format. A value of 0 means "use default".
 */
declare interface GhosttyTerminalConfig {
    scrollbackLimit?: number;
    fgColor?: number;
    bgColor?: number;
    cursorColor?: number;
    palette?: number[];
}

/**
 * Interface for libghostty-vt WASM exports
 */
declare interface GhosttyWasmExports extends WebAssembly.Exports {
    memory: WebAssembly.Memory;
    ghostty_wasm_alloc_opaque(): number;
    ghostty_wasm_free_opaque(ptr: number): void;
    ghostty_wasm_alloc_u8_array(len: number): number;
    ghostty_wasm_free_u8_array(ptr: number, len: number): void;
    ghostty_wasm_alloc_u16_array(len: number): number;
    ghostty_wasm_free_u16_array(ptr: number, len: number): void;
    ghostty_wasm_alloc_u8(): number;
    ghostty_wasm_free_u8(ptr: number): void;
    ghostty_wasm_alloc_usize(): number;
    ghostty_wasm_free_usize(ptr: number): void;
    ghostty_sgr_new(allocator: number, parserPtrPtr: number): number;
    ghostty_sgr_free(parser: number): void;
    ghostty_sgr_reset(parser: number): void;
    ghostty_sgr_set_params(parser: number, paramsPtr: number, subsPtr: number, paramsLen: number): number;
    ghostty_sgr_next(parser: number, attrPtr: number): boolean;
    ghostty_sgr_attribute_tag(attrPtr: number): number;
    ghostty_sgr_attribute_value(attrPtr: number, tagPtr: number): number;
    ghostty_wasm_alloc_sgr_attribute(): number;
    ghostty_wasm_free_sgr_attribute(ptr: number): void;
    ghostty_key_encoder_new(allocator: number, encoderPtrPtr: number): number;
    ghostty_key_encoder_free(encoder: number): void;
    ghostty_key_encoder_setopt(encoder: number, option: number, valuePtr: number): number;
    ghostty_key_encoder_encode(encoder: number, eventPtr: number, bufPtr: number, bufLen: number, writtenPtr: number): number;
    ghostty_key_event_new(allocator: number, eventPtrPtr: number): number;
    ghostty_key_event_free(event: number): void;
    ghostty_key_event_set_action(event: number, action: number): void;
    ghostty_key_event_set_key(event: number, key: number): void;
    ghostty_key_event_set_mods(event: number, mods: number): void;
    ghostty_key_event_set_utf8(event: number, ptr: number, len: number): void;
    ghostty_terminal_new(cols: number, rows: number): TerminalHandle;
    ghostty_terminal_new_with_config(cols: number, rows: number, configPtr: number): TerminalHandle;
    ghostty_terminal_free(terminal: TerminalHandle): void;
    ghostty_terminal_write(terminal: TerminalHandle, dataPtr: number, dataLen: number): void;
    ghostty_terminal_resize(terminal: TerminalHandle, cols: number, rows: number): void;
    ghostty_terminal_get_cols(terminal: TerminalHandle): number;
    ghostty_terminal_get_rows(terminal: TerminalHandle): number;
    ghostty_terminal_get_cursor_x(terminal: TerminalHandle): number;
    ghostty_terminal_get_cursor_y(terminal: TerminalHandle): number;
    ghostty_terminal_get_cursor_visible(terminal: TerminalHandle): boolean;
    ghostty_terminal_is_alternate_screen(terminal: TerminalHandle): boolean;
    ghostty_terminal_is_row_wrapped(terminal: TerminalHandle, row: number): boolean;
    ghostty_terminal_is_dirty(terminal: TerminalHandle): boolean;
    ghostty_terminal_is_row_dirty(terminal: TerminalHandle, row: number): boolean;
    ghostty_terminal_clear_dirty(terminal: TerminalHandle): void;
    ghostty_terminal_get_hyperlink_uri(terminal: TerminalHandle, hyperlinkId: number, bufPtr: number, bufLen: number): number;
    ghostty_terminal_get_line(terminal: TerminalHandle, row: number, bufPtr: number, bufLen: number): number;
    ghostty_terminal_get_scrollback_line(terminal: TerminalHandle, offset: number, bufPtr: number, bufLen: number): number;
    ghostty_terminal_get_scrollback_length(terminal: TerminalHandle): number;
    ghostty_terminal_get_mode(terminal: TerminalHandle, mode: number, isAnsi: number): number;
    ghostty_terminal_has_bracketed_paste(terminal: TerminalHandle): number;
    ghostty_terminal_has_focus_events(terminal: TerminalHandle): number;
    ghostty_terminal_has_mouse_tracking(terminal: TerminalHandle): number;
}

/**
 * A terminal buffer (normal or alternate screen)
 */
declare interface IBuffer {
    /** Buffer type: 'normal' or 'alternate' */
    readonly type: 'normal' | 'alternate';
    /** Cursor X position (0-indexed) */
    readonly cursorX: number;
    /** Cursor Y position (0-indexed, relative to viewport) */
    readonly cursorY: number;
    /** Viewport Y position (scroll offset, 0 = bottom of scrollback) */
    readonly viewportY: number;
    /** Base Y position (always 0 for normal buffer, may vary for alternate) */
    readonly baseY: number;
    /** Total buffer length (rows + scrollback for normal, just rows for alternate) */
    readonly length: number;
    /**
     * Get a line from the buffer
     * @param y Line index (0 = top of scrollback for normal buffer)
     * @returns Line object or undefined if out of bounds
     */
    getLine(y: number): IBufferLine | undefined;
    /**
     * Get the null cell (used for empty/uninitialized cells)
     */
    getNullCell(): IBufferCell;
}

/**
 * A single cell in the buffer
 */
declare interface IBufferCell {
    /** Character(s) in this cell (may be empty, single char, or emoji) */
    getChars(): string;
    /** Unicode codepoint (0 for null cell) */
    getCode(): number;
    /** Character width (1 = normal, 2 = wide/emoji, 0 = combining) */
    getWidth(): number;
    /** Foreground color index (for palette colors) or -1 for RGB */
    getFgColorMode(): number;
    /** Background color index (for palette colors) or -1 for RGB */
    getBgColorMode(): number;
    /** Foreground RGB color (or 0 for default) */
    getFgColor(): number;
    /** Background RGB color (or 0 for default) */
    getBgColor(): number;
    /** Whether cell has bold style */
    isBold(): number;
    /** Whether cell has italic style */
    isItalic(): number;
    /** Whether cell has underline style */
    isUnderline(): number;
    /** Whether cell has strikethrough style */
    isStrikethrough(): number;
    /** Whether cell has blink style */
    isBlink(): number;
    /** Whether cell has inverse video style */
    isInverse(): number;
    /** Whether cell has invisible style */
    isInvisible(): number;
    /** Whether cell has faint/dim style */
    isFaint(): number;
    /** Get hyperlink ID for this cell (0 = no link) */
    getHyperlinkId(): number;
    /** Get the Unicode codepoint for this cell */
    getCodepoint(): number;
    /** Whether cell has dim/faint attribute (boolean version) */
    isDim(): boolean;
}

/**
 * Represents a coordinate in the terminal buffer
 */
export declare interface IBufferCellPosition {
    x: number;
    y: number;
}

/**
 * A single line in the buffer
 */
declare interface IBufferLine {
    /** Length of the line (in columns) */
    readonly length: number;
    /** Whether this line wraps to the next line */
    readonly isWrapped: boolean;
    /**
     * Get a cell from this line
     * @param x Column index (0-indexed)
     * @returns Cell object or undefined if out of bounds
     */
    getCell(x: number): IBufferCell | undefined;
    /**
     * Translate the line to a string
     * @param trimRight Whether to trim trailing whitespace (default: false)
     * @param startColumn Start column (default: 0)
     * @param endColumn End column (default: length)
     * @returns String representation of the line
     */
    translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

/**
 * Minimal buffer line interface for URL detection
 */
declare interface IBufferLineForUrlProvider {
    length: number;
    getCell(x: number): {
        getCodepoint(): number;
    } | undefined;
}

/**
 * Top-level buffer API namespace
 * Provides access to active, normal, and alternate screen buffers
 */
declare interface IBufferNamespace {
    /** The currently active buffer (normal or alternate) */
    readonly active: IBuffer;
    /** The normal buffer (primary screen) */
    readonly normal: IBuffer;
    /** The alternate buffer (used by full-screen apps like vim) */
    readonly alternate: IBuffer;
    /** Event fired when buffer changes (normal ↔ alternate) */
    readonly onBufferChange: IEvent<IBuffer>;
}

/**
 * Buffer range for selection coordinates
 */
export declare interface IBufferRange {
    start: {
        x: number;
        y: number;
    };
    end: {
        x: number;
        y: number;
    };
}

/**
 * Represents a range in the terminal buffer
 * Can span multiple lines for wrapped links
 */
declare interface IBufferRange_2 {
    start: IBufferCellPosition;
    end: IBufferCellPosition;
}

export declare interface IDisposable {
    dispose(): void;
}

export declare type IEvent<T> = (listener: (arg: T) => void) => IDisposable;

/**
 * Keyboard event with key and DOM event
 */
export declare interface IKeyEvent {
    key: string;
    domEvent: KeyboardEvent;
}

/**
 * Represents a detected link in the terminal
 */
export declare interface ILink {
    /** The URL or text of the link */
    text: string;
    /** The range of the link in the buffer (may span multiple lines) */
    range: IBufferRange_2;
    /** Called when the link is activated (clicked with modifier) */
    activate(event: MouseEvent): void;
    /** Optional: called when mouse enters/leaves the link */
    hover?(isHovered: boolean): void;
    /** Optional: called to clean up resources */
    dispose?(): void;
}

/**
 * Provides link detection for a specific type of link
 * Examples: OSC 8 hyperlinks, URL regex detection
 */
export declare interface ILinkProvider {
    /**
     * Provide links for a given row
     * @param y Absolute row in buffer (0-based)
     * @param callback Called with detected links (or undefined if none)
     */
    provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void;
    /** Optional: called when terminal is disposed */
    dispose?(): void;
}

/**
 * Initialize the ghostty-web library by loading the WASM module.
 * Must be called before creating any Terminal instances.
 *
 * This creates a shared WASM instance that all Terminal instances will use.
 * For test isolation, pass a Ghostty instance directly to Terminal constructor.
 *
 * @example
 * ```typescript
 * import { init, Terminal } from 'ghostty-web';
 *
 * await init();
 * const term = new Terminal();
 * term.open(document.getElementById('terminal'));
 * ```
 */
export declare function init(): Promise<void>;

/**
 * InputHandler class
 * Attaches keyboard event listeners to a container and converts
 * keyboard events to terminal input data
 */
export declare class InputHandler {
    private encoder;
    private container;
    private onDataCallback;
    private onBellCallback;
    private onKeyCallback?;
    private customKeyEventHandler?;
    private keydownListener;
    private keypressListener;
    private pasteListener;
    private isDisposed;
    /**
     * Create a new InputHandler
     * @param ghostty - Ghostty instance (for creating KeyEncoder)
     * @param container - DOM element to attach listeners to
     * @param onData - Callback for terminal data (escape sequences to send to PTY)
     * @param onBell - Callback for bell/beep event
     * @param onKey - Optional callback for raw key events
     * @param customKeyEventHandler - Optional custom key event handler
     */
    constructor(ghostty: Ghostty, container: HTMLElement, onData: (data: string) => void, onBell: () => void, onKey?: (keyEvent: IKeyEvent) => void, customKeyEventHandler?: (event: KeyboardEvent) => boolean);
    /**
     * Set custom key event handler (for runtime updates)
     */
    setCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
    /**
     * Attach keyboard event listeners to container
     */
    private attach;
    /**
     * Map KeyboardEvent.code to USB HID Key enum value
     * @param code - KeyboardEvent.code value
     * @returns Key enum value or null if unmapped
     */
    private mapKeyCode;
    /**
     * Extract modifier flags from KeyboardEvent
     * @param event - KeyboardEvent
     * @returns Mods flags
     */
    private extractModifiers;
    /**
     * Check if this is a printable character with no special modifiers
     * @param event - KeyboardEvent
     * @returns true if printable character
     */
    private isPrintableCharacter;
    /**
     * Handle keydown event
     * @param event - KeyboardEvent
     */
    private handleKeyDown;
    /**
     * Handle paste event from clipboard
     * @param event - ClipboardEvent
     */
    private handlePaste;
    /**
     * Dispose the InputHandler and remove event listeners
     */
    dispose(): void;
    /**
     * Check if handler is disposed
     */
    isActive(): boolean;
}

export declare interface IRenderable {
    getLine(y: number): GhosttyCell[] | null;
    getCursor(): {
        x: number;
        y: number;
        visible: boolean;
    };
    getDimensions(): {
        cols: number;
        rows: number;
    };
    isRowDirty(y: number): boolean;
    clearDirty(): void;
}

declare interface IScrollbackProvider {
    getScrollbackLine(offset: number): GhosttyCell[] | null;
    getScrollbackLength(): number;
}

export declare interface ITerminalAddon {
    activate(terminal: ITerminalCore): void;
    dispose(): void;
}

export declare interface ITerminalCore {
    cols: number;
    rows: number;
    element?: HTMLElement;
    textarea?: HTMLTextAreaElement;
}

export declare interface ITerminalDimensions {
    cols: number;
    rows: number;
}

/**
 * Minimal terminal interface required by LinkDetector
 * Keeps coupling low and testing easy
 */
declare interface ITerminalForLinkDetector {
    buffer: {
        active: {
            getLine(y: number): {
                length: number;
                getCell(x: number): {
                    getHyperlinkId(): number;
                } | undefined;
            } | undefined;
        };
    };
}

/**
 * Minimal terminal interface required by OSC8LinkProvider
 */
declare interface ITerminalForOSC8Provider {
    buffer: {
        active: {
            length: number;
            getLine(y: number): {
                length: number;
                getCell(x: number): {
                    getHyperlinkId(): number;
                } | undefined;
            } | undefined;
        };
    };
    wasmTerm?: {
        getHyperlinkUri(id: number): string | null;
    };
}

/**
 * Minimal terminal interface required by UrlRegexProvider
 */
declare interface ITerminalForUrlProvider {
    buffer: {
        active: {
            getLine(y: number): IBufferLineForUrlProvider | undefined;
        };
    };
}

export declare interface ITerminalOptions {
    cols?: number;
    rows?: number;
    cursorBlink?: boolean;
    cursorStyle?: 'block' | 'underline' | 'bar';
    theme?: ITheme;
    scrollback?: number;
    fontSize?: number;
    fontFamily?: string;
    allowTransparency?: boolean;
    convertEol?: boolean;
    disableStdin?: boolean;
    smoothScrollDuration?: number;
    ghostty?: Ghostty;
}

export declare interface ITheme {
    foreground?: string;
    background?: string;
    cursor?: string;
    cursorAccent?: string;
    selectionBackground?: string;
    selectionForeground?: string;
    black?: string;
    red?: string;
    green?: string;
    yellow?: string;
    blue?: string;
    magenta?: string;
    cyan?: string;
    white?: string;
    brightBlack?: string;
    brightRed?: string;
    brightGreen?: string;
    brightYellow?: string;
    brightBlue?: string;
    brightMagenta?: string;
    brightCyan?: string;
    brightWhite?: string;
}

/**
 * Unicode version provider (xterm.js compatibility)
 */
export declare interface IUnicodeVersionProvider {
    readonly activeVersion: string;
}

/**
 * Physical key codes (based on USB HID Usage Tables - Keyboard/Keypad Page 0x07)
 * Reference: https://www.usb.org/sites/default/files/hut1_21.pdf
 */
export declare enum Key {
    A = 4,
    B = 5,
    C = 6,
    D = 7,
    E = 8,
    F = 9,
    G = 10,
    H = 11,
    I = 12,
    J = 13,
    K = 14,
    L = 15,
    M = 16,
    N = 17,
    O = 18,
    P = 19,
    Q = 20,
    R = 21,
    S = 22,
    T = 23,
    U = 24,
    V = 25,
    W = 26,
    X = 27,
    Y = 28,
    Z = 29,
    ONE = 30,
    TWO = 31,
    THREE = 32,
    FOUR = 33,
    FIVE = 34,
    SIX = 35,
    SEVEN = 36,
    EIGHT = 37,
    NINE = 38,
    ZERO = 39,
    ENTER = 40,
    ESCAPE = 41,
    BACKSPACE = 42,
    TAB = 43,
    SPACE = 44,
    MINUS = 45,// - and _
    EQUAL = 46,// = and +
    BRACKET_LEFT = 47,// [ and {
    BRACKET_RIGHT = 48,// ] and }
    BACKSLASH = 49,// \ and |
    SEMICOLON = 51,// ; and :
    QUOTE = 52,// ' and "
    GRAVE = 53,// ` and ~
    COMMA = 54,// , and <
    PERIOD = 55,// . and >
    SLASH = 56,// / and ?
    CAPS_LOCK = 57,
    F1 = 58,
    F2 = 59,
    F3 = 60,
    F4 = 61,
    F5 = 62,
    F6 = 63,
    F7 = 64,
    F8 = 65,
    F9 = 66,
    F10 = 67,
    F11 = 68,
    F12 = 69,
    PRINT_SCREEN = 70,
    SCROLL_LOCK = 71,
    PAUSE = 72,
    INSERT = 73,
    HOME = 74,
    PAGE_UP = 75,
    DELETE = 76,
    END = 77,
    PAGE_DOWN = 78,
    RIGHT = 79,
    LEFT = 80,
    DOWN = 81,
    UP = 82,
    NUM_LOCK = 83,
    KP_DIVIDE = 84,// Keypad /
    KP_MULTIPLY = 85,// Keypad *
    KP_MINUS = 86,// Keypad -
    KP_PLUS = 87,// Keypad +
    KP_ENTER = 88,// Keypad Enter
    KP_1 = 89,
    KP_2 = 90,
    KP_3 = 91,
    KP_4 = 92,
    KP_5 = 93,
    KP_6 = 94,
    KP_7 = 95,
    KP_8 = 96,
    KP_9 = 97,
    KP_0 = 98,
    KP_PERIOD = 99,// Keypad .
    NON_US_BACKSLASH = 100,// \ and | on non-US keyboards
    APPLICATION = 101,// Context menu key
    F13 = 104,
    F14 = 105,
    F15 = 106,
    F16 = 107,
    F17 = 108,
    F18 = 109,
    F19 = 110,
    F20 = 111,
    F21 = 112,
    F22 = 113,
    F23 = 114,
    F24 = 115
}

/**
 * Key action
 */
export declare enum KeyAction {
    RELEASE = 0,
    PRESS = 1,
    REPEAT = 2
}

/**
 * Key Encoder
 * Converts keyboard events into terminal escape sequences
 */
export declare class KeyEncoder {
    private exports;
    private encoder;
    constructor(exports: GhosttyWasmExports);
    /**
     * Set an encoder option
     */
    setOption(option: KeyEncoderOption, value: boolean | number): void;
    /**
     * Enable Kitty keyboard protocol with specified flags
     */
    setKittyFlags(flags: KittyKeyFlags): void;
    /**
     * Encode a key event to escape sequence
     */
    encode(event: KeyEvent): Uint8Array;
    /**
     * Free encoder resources
     */
    dispose(): void;
}

/**
 * Key encoder options
 */
export declare enum KeyEncoderOption {
    CURSOR_KEY_APPLICATION = 0,// DEC mode 1
    KEYPAD_KEY_APPLICATION = 1,// DEC mode 66
    IGNORE_KEYPAD_WITH_NUMLOCK = 2,// DEC mode 1035
    ALT_ESC_PREFIX = 3,// DEC mode 1036
    MODIFY_OTHER_KEYS_STATE_2 = 4,// xterm modifyOtherKeys
    KITTY_KEYBOARD_FLAGS = 5
}

/**
 * Key event structure
 */
export declare interface KeyEvent {
    action: KeyAction;
    key: Key;
    mods: Mods;
    consumedMods?: Mods;
    composing?: boolean;
    utf8?: string;
    unshiftedCodepoint?: number;
}

/**
 * Kitty keyboard protocol flags
 * From include/ghostty/vt/key/encoder.h
 */
declare enum KittyKeyFlags {
    DISABLED = 0,
    DISAMBIGUATE = 1,// Disambiguate escape codes
    REPORT_EVENTS = 2,// Report press and release
    REPORT_ALTERNATES = 4,// Report alternate key codes
    REPORT_ALL = 8,// Report all events
    REPORT_ASSOCIATED = 16,// Report associated text
    ALL = 31
}

/**
 * Manages link detection across multiple providers with intelligent caching
 */
export declare class LinkDetector {
    private terminal;
    private providers;
    private linkCache;
    private scannedRows;
    constructor(terminal: ITerminalForLinkDetector);
    /**
     * Register a link provider
     */
    registerProvider(provider: ILinkProvider): void;
    /**
     * Get link at the specified buffer position
     * @param col Column (0-based)
     * @param row Absolute row in buffer (0-based)
     * @returns Link at position, or undefined if none
     */
    getLinkAt(col: number, row: number): Promise<ILink | undefined>;
    /**
     * Scan a row for links using all registered providers
     */
    private scanRow;
    /**
     * Cache a link for fast lookup
     */
    private cacheLink;
    /**
     * Check if a position is within a link's range
     */
    private isPositionInLink;
    /**
     * Invalidate cache when terminal content changes
     * Should be called on terminal write, resize, or clear
     */
    invalidateCache(): void;
    /**
     * Invalidate cache for specific rows
     * Used when only part of the terminal changed
     */
    invalidateRows(startRow: number, endRow: number): void;
    /**
     * Dispose and cleanup
     */
    dispose(): void;
}

/**
 * Modifier keys
 */
export declare enum Mods {
    NONE = 0,
    SHIFT = 1,
    CTRL = 2,
    ALT = 4,
    SUPER = 8,// Windows/Command key
    CAPSLOCK = 16,
    NUMLOCK = 32
}

/**
 * OSC 8 Hyperlink Provider
 *
 * Detects OSC 8 hyperlinks by scanning for hyperlink_id in cells.
 * Automatically handles multi-line links since Ghostty WASM preserves
 * hyperlink_id across wrapped lines.
 */
export declare class OSC8LinkProvider implements ILinkProvider {
    private terminal;
    constructor(terminal: ITerminalForOSC8Provider);
    /**
     * Provide all OSC 8 links on the given row
     * Note: This may return links that span multiple rows
     */
    provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void;
    /**
     * Find the full extent of a link by scanning for contiguous cells
     * with the same hyperlink_id. Handles multi-line links.
     */
    private findLinkRange;
    dispose(): void;
}

export declare interface RendererOptions {
    fontSize?: number;
    fontFamily?: string;
    cursorStyle?: 'block' | 'underline' | 'bar';
    cursorBlink?: boolean;
    theme?: ITheme;
    devicePixelRatio?: number;
}

/**
 * RGB color
 */
export declare interface RGB {
    r: number;
    g: number;
    b: number;
}

export declare interface SelectionCoordinates {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
}

export declare class SelectionManager {
    private terminal;
    private renderer;
    private wasmTerm;
    private textarea;
    private selectionStart;
    private selectionEnd;
    private isSelecting;
    private mouseDownTarget;
    private dirtySelectionRows;
    private selectionChangedEmitter;
    private boundMouseUpHandler;
    private boundContextMenuHandler;
    private boundClickHandler;
    private boundDocumentMouseMoveHandler;
    private autoScrollInterval;
    private autoScrollDirection;
    private static readonly AUTO_SCROLL_EDGE_SIZE;
    /**
     * Get current viewport Y position (how many lines scrolled into history)
     */
    private getViewportY;
    /**
     * Convert viewport row to absolute buffer row
     * Absolute row is an index into combined buffer: scrollback (0 to len-1) + screen (len to len+rows-1)
     */
    private viewportRowToAbsolute;
    /**
     * Convert absolute buffer row to viewport row (may be outside visible range)
     */
    private absoluteRowToViewport;
    private static readonly AUTO_SCROLL_SPEED;
    private static readonly AUTO_SCROLL_INTERVAL;
    constructor(terminal: Terminal, renderer: CanvasRenderer, wasmTerm: GhosttyTerminal, textarea: HTMLTextAreaElement);
    /**
     * Get the selected text as a string
     */
    getSelection(): string;
    /**
     * Check if there's an active selection
     */
    hasSelection(): boolean;
    /**
     * Clear the selection
     */
    clearSelection(): void;
    /**
     * Select all text in the terminal
     */
    selectAll(): void;
    /**
     * Select text at specific column and row with length
     * xterm.js compatible API
     */
    select(column: number, row: number, length: number): void;
    /**
     * Select entire lines from start to end
     * xterm.js compatible API
     */
    selectLines(start: number, end: number): void;
    /**
     * Get selection position as buffer range
     * xterm.js compatible API
     */
    getSelectionPosition(): {
        start: {
            x: number;
            y: number;
        };
        end: {
            x: number;
            y: number;
        };
    } | undefined;
    /**
     * Deselect all text
     * xterm.js compatible API
     */
    deselect(): void;
    /**
     * Focus the terminal (make it receive keyboard input)
     */
    focus(): void;
    /**
     * Get current selection coordinates (for rendering)
     */
    getSelectionCoords(): SelectionCoordinates | null;
    /**
     * Get dirty selection rows that need redraw (for clearing old highlight)
     */
    getDirtySelectionRows(): Set<number>;
    /**
     * Clear the dirty selection rows tracking (after redraw)
     */
    clearDirtySelectionRows(): void;
    /**
     * Get selection change event accessor
     */
    get onSelectionChange(): IEvent<void>;
    /**
     * Cleanup resources
     */
    dispose(): void;
    /**
     * Attach mouse event listeners to canvas
     */
    private attachEventListeners;
    /**
     * Mark current selection rows as dirty for redraw
     */
    private markCurrentSelectionDirty;
    /**
     * Update auto-scroll based on mouse Y position within canvas
     */
    private updateAutoScroll;
    /**
     * Start auto-scrolling in the given direction
     */
    private startAutoScroll;
    /**
     * Stop auto-scrolling
     */
    private stopAutoScroll;
    /**
     * Convert pixel coordinates to terminal cell coordinates
     */
    private pixelToCell;
    /**
     * Normalize selection coordinates (handle backward selection)
     * Returns coordinates in VIEWPORT space for rendering, clamped to visible area
     */
    private normalizeSelection;
    /**
     * Get word boundaries at a cell position
     */
    private getWordAtCell;
    /**
     * Copy text to clipboard
     */
    private copyToClipboard;
    /**
     * Request a render update (triggers selection overlay redraw)
     */
    private requestRender;
}

export declare class Terminal implements ITerminalCore {
    cols: number;
    rows: number;
    element?: HTMLElement;
    textarea?: HTMLTextAreaElement;
    readonly buffer: IBufferNamespace;
    readonly unicode: IUnicodeVersionProvider;
    readonly options: Required<ITerminalOptions>;
    private ghostty?;
    wasmTerm?: GhosttyTerminal;
    renderer?: CanvasRenderer;
    private inputHandler?;
    private selectionManager?;
    private canvas?;
    private linkDetector?;
    private currentHoveredLink?;
    private mouseMoveThrottleTimeout?;
    private pendingMouseMove?;
    private dataEmitter;
    private resizeEmitter;
    private bellEmitter;
    private selectionChangeEmitter;
    private keyEmitter;
    private titleChangeEmitter;
    private scrollEmitter;
    private renderEmitter;
    private cursorMoveEmitter;
    readonly onData: IEvent<string>;
    readonly onResize: IEvent<{
        cols: number;
        rows: number;
    }>;
    readonly onBell: IEvent<void>;
    readonly onSelectionChange: IEvent<void>;
    readonly onKey: IEvent<IKeyEvent>;
    readonly onTitleChange: IEvent<string>;
    readonly onScroll: IEvent<number>;
    readonly onRender: IEvent<{
        start: number;
        end: number;
    }>;
    readonly onCursorMove: IEvent<void>;
    private isOpen;
    private isDisposed;
    private animationFrameId?;
    private addons;
    private customKeyEventHandler?;
    private currentTitle;
    private viewportY;
    private targetViewportY;
    private scrollAnimationStartTime?;
    private scrollAnimationStartY?;
    private scrollAnimationFrame?;
    private customWheelEventHandler?;
    private lastCursorY;
    private isDraggingScrollbar;
    private scrollbarDragStart;
    private scrollbarDragStartViewportY;
    private scrollbarVisible;
    private scrollbarOpacity;
    private scrollbarHideTimeout?;
    private readonly SCROLLBAR_HIDE_DELAY_MS;
    private readonly SCROLLBAR_FADE_DURATION_MS;
    constructor(options?: ITerminalOptions);
    /**
     * Parse a CSS color string to 0xRRGGBB format.
     * Returns 0 if the color is undefined or invalid.
     */
    private parseColorToHex;
    /**
     * Convert terminal options to WASM terminal config.
     */
    private buildWasmConfig;
    /**
     * Handle runtime option changes (called when options are modified after terminal is open)
     * This enables xterm.js compatibility where options can be changed at runtime
     */
    private handleOptionChange;
    /**
     * Open terminal in a parent element
     *
     * Initializes all components and starts rendering.
     * Requires a pre-loaded Ghostty instance passed to the constructor.
     */
    open(parent: HTMLElement): void;
    /**
     * Write data to terminal
     */
    write(data: string | Uint8Array, callback?: () => void): void;
    /**
     * Internal write implementation (extracted from write())
     */
    private writeInternal;
    /**
     * Write data with newline
     */
    writeln(data: string | Uint8Array, callback?: () => void): void;
    /**
     * Paste text into terminal (triggers bracketed paste if supported)
     */
    paste(data: string): void;
    /**
     * Input data into terminal (as if typed by user)
     *
     * @param data - Data to input
     * @param wasUserInput - If true, triggers onData event (default: false for compat with some apps)
     */
    input(data: string, wasUserInput?: boolean): void;
    /**
     * Resize terminal
     */
    resize(cols: number, rows: number): void;
    /**
     * Clear terminal screen
     */
    clear(): void;
    /**
     * Reset terminal state
     */
    reset(): void;
    /**
     * Focus terminal input
     */
    focus(): void;
    /**
     * Blur terminal (remove focus)
     */
    blur(): void;
    /**
     * Load an addon
     */
    loadAddon(addon: ITerminalAddon): void;
    /**
     * Get the selected text as a string
     */
    getSelection(): string;
    /**
     * Check if there's an active selection
     */
    hasSelection(): boolean;
    /**
     * Clear the current selection
     */
    clearSelection(): void;
    /**
     * Select all text in the terminal
     */
    selectAll(): void;
    /**
     * Select text at specific column and row with length
     */
    select(column: number, row: number, length: number): void;
    /**
     * Select entire lines from start to end
     */
    selectLines(start: number, end: number): void;
    /**
     * Get selection position as buffer range
     */
    /**
     * Get the current viewport Y position.
     *
     * This is the number of lines scrolled back from the bottom of the
     * scrollback buffer. It may be fractional during smooth scrolling.
     */
    getViewportY(): number;
    getSelectionPosition(): IBufferRange | undefined;
    /**
     * Attach a custom keyboard event handler
     * Returns true to prevent default handling
     */
    attachCustomKeyEventHandler(customKeyEventHandler: (event: KeyboardEvent) => boolean): void;
    /**
     * Attach a custom wheel event handler (Phase 2)
     * Returns true to prevent default handling
     */
    attachCustomWheelEventHandler(customWheelEventHandler?: (event: WheelEvent) => boolean): void;
    /**
     * Register a custom link provider
     * Multiple providers can be registered to detect different types of links
     *
     * @example
     * ```typescript
     * term.registerLinkProvider({
     *   provideLinks(y, callback) {
     *     // Detect URLs, file paths, etc.
     *     callback(detectedLinks);
     *   }
     * });
     * ```
     */
    registerLinkProvider(provider: ILinkProvider): void;
    /**
     * Scroll viewport by a number of lines
     * @param amount Number of lines to scroll (positive = down, negative = up)
     */
    scrollLines(amount: number): void;
    /**
     * Scroll viewport by a number of pages
     * @param amount Number of pages to scroll (positive = down, negative = up)
     */
    scrollPages(amount: number): void;
    /**
     * Scroll viewport to the top of the scrollback buffer
     */
    scrollToTop(): void;
    /**
     * Scroll viewport to the bottom (current output)
     */
    scrollToBottom(): void;
    /**
     * Scroll viewport to a specific line in the buffer
     * @param line Line number (0 = top of scrollback, scrollbackLength = bottom)
     */
    scrollToLine(line: number): void;
    /**
     * Smoothly scroll to a target viewport position
     * @param targetY Target viewport Y position (in lines, can be fractional)
     */
    private smoothScrollTo;
    /**
     * Animation loop for smooth scrolling
     * Uses asymptotic approach - moves a fraction of remaining distance each frame
     */
    private animateScroll;
    /**
     * Dispose terminal and clean up resources
     */
    dispose(): void;
    /**
     * Start the render loop
     */
    private startRenderLoop;
    /**
     * Get a line from native WASM scrollback buffer
     * Implements IScrollbackProvider
     */
    getScrollbackLine(offset: number): GhosttyCell[] | null;
    /**
     * Get scrollback length from native WASM
     * Implements IScrollbackProvider
     */
    getScrollbackLength(): number;
    /**
     * Clean up components (called on dispose or error)
     */
    private cleanupComponents;
    /**
     * Assert terminal is open (throw if not)
     */
    private assertOpen;
    /**
     * Handle mouse move for link hover detection and scrollbar dragging
     * Throttled to avoid blocking scroll events (except when dragging scrollbar)
     */
    private handleMouseMove;
    /**
     * Process mouse move for link detection (internal, called by throttled handler)
     */
    private processMouseMove;
    /**
     * Handle mouse leave to clear link hover
     */
    private handleMouseLeave;
    /**
     * Handle mouse click for link activation
     */
    private handleClick;
    /**
     * Handle wheel events for scrolling (Phase 2)
     */
    private handleWheel;
    /**
     * Handle mouse down for scrollbar interaction
     */
    private handleMouseDown;
    /**
     * Handle mouse up for scrollbar drag
     */
    private handleMouseUp;
    /**
     * Process scrollbar drag movement
     */
    private processScrollbarDrag;
    /**
     * Show scrollbar with fade-in and schedule auto-hide
     */
    private showScrollbar;
    /**
     * Hide scrollbar with fade-out
     */
    private hideScrollbar;
    /**
     * Fade in scrollbar
     */
    private fadeInScrollbar;
    /**
     * Fade out scrollbar
     */
    private fadeOutScrollbar;
    /**
     * Check for title changes in written data (OSC sequences)
     * Simplified implementation - looks for OSC 0, 1, 2
     */
    private checkForTitleChange;
    /**
     * Query terminal mode state
     *
     * @param mode Mode number (e.g., 2004 for bracketed paste)
     * @param isAnsi True for ANSI modes, false for DEC modes (default: false)
     * @returns true if mode is enabled
     */
    getMode(mode: number, isAnsi?: boolean): boolean;
    /**
     * Check if bracketed paste mode is enabled
     */
    hasBracketedPaste(): boolean;
    /**
     * Check if focus event reporting is enabled
     */
    hasFocusEvents(): boolean;
    /**
     * Check if mouse tracking is enabled
     */
    hasMouseTracking(): boolean;
}

/**
 * Opaque terminal pointer (WASM memory address)
 */
export declare type TerminalHandle = number;

/**
 * URL Regex Provider
 *
 * Detects plain text URLs on a single line using regex.
 * Does not support multi-line URLs or file paths.
 *
 * Supported protocols:
 * - https://, http://
 * - mailto:
 * - ftp://, ssh://, git://
 * - tel:, magnet:
 * - gemini://, gopher://, news:
 */
export declare class UrlRegexProvider implements ILinkProvider {
    private terminal;
    /**
     * URL regex pattern
     * Matches common protocols followed by valid URL characters
     * Excludes file paths (no ./ or ../ or bare /)
     */
    private static readonly URL_REGEX;
    /**
     * Characters to strip from end of URLs
     * Common punctuation that's unlikely to be part of the URL
     */
    private static readonly TRAILING_PUNCTUATION;
    constructor(terminal: ITerminalForUrlProvider);
    /**
     * Provide all regex-detected URLs on the given row
     */
    provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void;
    /**
     * Convert a buffer line to plain text string
     */
    private lineToText;
    dispose(): void;
}

export { }
