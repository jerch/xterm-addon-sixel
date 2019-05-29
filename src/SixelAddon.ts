/**
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * @license MIT
 *
 * Implements SIXEL support.
 */

import { Terminal, IDisposable } from 'xterm';
import { SixelImage, toRGBA8888 } from 'sixel';
import { ImageSize, ImageType, ISize as IImageSize } from 'imagesize';

// buffer placeholder
// FIXME: find better method to announce foreign content
const CODE = 0x110000; // illegal unicode char
const INVISIBLE = 0x40000000; // taken from BufferLine.ts


// TODO: This is temporary, link to xterm when the new version is published
export interface ITerminalAddon {
  activate(terminal: Terminal): void;
  dispose(): void;
}

interface IDcsHandler {
  hook(collect: string, params: number[], flag: number): void;
  put(data: Uint32Array, start: number, end: number): void;
  unhook(): void;
}

interface CellSize {
  width: number;
  height: number;
}

interface IImageSpec {
  orig: HTMLCanvasElement;
  origCellSize: CellSize;
  actual: HTMLCanvasElement;
  actualCellSize: CellSize;
  urlCache: {[key: number]: string};
}

type UintTypedArray = Uint8Array | Uint16Array | Uint32Array | Uint8ClampedArray;

/**
 * Image Storage
 * 
 * TODO: add markers for lifecycle management
 * TODO: make _images a {}
 */
class ImageStorage {
  private _images: IImageSpec[] = [];

  constructor(private _terminal: Terminal) {}

  private get _cellSize(): CellSize {
    const internalTerm = (this._terminal as any)._core;
    return {
      width: internalTerm.renderer.dimensions.actualCellWidth,
      height: internalTerm.renderer.dimensions.actualCellHeight
    }
  }

  private _rescale(imgId: number): void {
    const {width: cw, height: ch} = this._cellSize;
    const {width: aw, height: ah} = this._images[imgId].actualCellSize;
    if (cw === aw && ch === ah) {
      return;
    }
    const {width: ow, height: oh} = this._images[imgId].origCellSize;
    if (cw === ow && ch === oh) {
      this._images[imgId].actual = this._images[imgId].orig;
      this._images[imgId].actualCellSize.width = ow;
      this._images[imgId].actualCellSize.height = oh;
      this._images[imgId].urlCache = {};
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(this._images[imgId].orig.width * cw / ow);
    canvas.height = Math.ceil(this._images[imgId].orig.height * ch / oh);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(this._images[imgId].orig, 0, 0, canvas.width, canvas.height);
      this._images[imgId].actual = canvas;
      this._images[imgId].actualCellSize.width = cw;
      this._images[imgId].actualCellSize.height = ch;
      this._images[imgId].urlCache = {};
    }
  }

  /**
   * Method to add an image to the storage.
   * Does all the needed low level stuff to tile the image data correctly
   * onto the terminal buffer cells.
   */
  public addImage(img: HTMLCanvasElement): number {
    /**
     * TODO - create markers:
     *    start marker  - first line containing image data
     *    end marker    - line below last line containing image data
     * 
     * use markers:
     *  - speedup rendering
     *    instead of searching cell by cell through all viewport cells,
     *    search for image start-end marker intersections with viewport lines
     *  - lifecycling of images
     *    delete image as soon as end marker got disposed
     */

    // calc rows x cols needed to display the image
    const cols = Math.ceil(img.width / this._cellSize.width);
    const rows = Math.ceil(img.height / this._cellSize.height);

    const position = this._images.length;
    this._images.push({
      orig: img,
      origCellSize: this._cellSize,
      actual: img,
      actualCellSize: this._cellSize,
      urlCache: {}
    });

    // write placeholder into terminal buffer
    const imgIdx = this._images.length - 1;
    const fg = INVISIBLE | imgIdx;

    const internalTerm = (this._terminal as any)._core;
    const buffer = internalTerm.buffer;
    const offset = internalTerm.buffer.x;

    for (let row = 0; row < rows; ++row) {
      const bufferRow = buffer.lines.get(buffer.y + buffer.ybase);
      for (let col = 0; col < cols; ++col) {
        if (offset + col >= internalTerm.cols) {
          break;
        }
        const tileNum = row * cols + col;
        bufferRow.setCellFromCodePoint(offset + col, CODE, 1, fg, tileNum);
      }
      if (row < rows - 1) {
        buffer.y++;
        if (buffer.y > buffer.scrollBottom) {
          buffer.y--;
          internalTerm.scroll(false);
        }
      }
    }
    if (offset + cols >= internalTerm.cols) {
      buffer.y++;
      if (buffer.y > buffer.scrollBottom) {
        buffer.y--;
        internalTerm.scroll(false);
      }
      internalTerm.buffer.x = 0;
    } else {
      internalTerm.buffer.x = offset + cols;
    }
    return position;
  }

  /**
   * Translates a SixelImage into a canvas and calls `addImage`.
   * @param sixel SixelImage
   */
  public addImageFromSixel(sixel: SixelImage): void {
    const canvas = document.createElement('canvas');
    canvas.width = sixel.width;
    canvas.height = sixel.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const imageData = ctx.getImageData(0, 0, sixel.width, sixel.height);

      // whether current BG should be applied to sixel image
      const applyBG = !!sixel.fillColor;
      if (applyBG) {
        // FIXME: get current BG somehow from terminal and convert to RGBA
        const fill = toRGBA8888(0, 0, 0, 255); // black for now
        sixel.toImageData(imageData.data, sixel.width, sixel.height, 0, 0, 0, 0, sixel.width, sixel.height, fill);
      } else {
        sixel.toImageData(imageData.data, sixel.width, sixel.height);
      }

      ctx.putImageData(imageData, 0, 0);
      this.addImage(canvas);
    }
  }

  public addImageFromBase64(payload: UintTypedArray, size: IImageSize): void {
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const pos = this.addImage(canvas);
    const img = new Image(size.width, size.height);
    img.onload = () => {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        // force refresh on this image
        this._images[pos].actualCellSize = {width: 0, height: 0};
        this._terminal.refresh(0, this._terminal.rows);
      }
    }
    // create data url
    let data = '';
    for (let i = 0; i < payload.length; ++i) {
      data += String.fromCharCode(payload[i]);
    }
    let intro = '';
    switch (size.type) {
      case ImageType.GIF:
        intro = 'data:image/gif;base64,';
        break;
      case ImageType.JPEG:
        intro = 'data:image/jpeg;base64,';
        break;
      case ImageType.PNG:
        intro = 'data:image/png;base64,';
        break;
    }
    img.src = intro + data;
  }

  public render(e: {start: number, end: number}): void {
    const {start, end} = e;
    const internalTerm = (this._terminal as any)._core;
    const buffer = internalTerm.buffer;

    const renderType = this._terminal.getOption('rendererType');
    let rows: any = null;
    let parent: any = null;
    if (renderType === 'dom') {
      rows = document.getElementsByClassName('xterm-rows')[0];
      parent = rows.parentNode;
      rows.remove();
    }
    
    // walk all cells in viewport and draw tile if needed
    for (let row = start; row <= end; ++row) {
      const bufferRow = buffer.lines.get(row + buffer.ydisp);
      for (let col = 0; col < internalTerm.cols; ++col) {
        if (bufferRow.getCodePoint(col) === CODE) {
          const fg = bufferRow.getFg(col);
          if (fg & INVISIBLE) {
            if (renderType === 'canvas') {
              this._drawToCanvas(fg & 0xFFFFFF, bufferRow.getBg(col) & 0xFFFFFF, col, row);
            } else if (renderType === 'dom') {
              this._drawToDom(fg & 0xFFFFFF, bufferRow.getBg(col) & 0xFFFFFF, col, row, rows);
            } else {
              throw new Error('unssuported renderer');
            }
          }
        }
      }
    }

    if (renderType === 'dom') {
      parent.append(rows);
    }
  }

  private _drawToDom(imgId: number, tileId: number, col: number, row: number, rows: any): void {
    this._rescale(imgId);
    let dataUrl = this._images[imgId].urlCache[tileId];
    if (!dataUrl) {
      const img = this._images[imgId].actual;
      const {width: cellWidth, height: cellHeight} = this._cellSize;
      const cols = Math.ceil(img.width / cellWidth);
  
      const canvas = document.createElement('canvas');
      canvas.width = cellWidth;
      canvas.height = cellHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return;
      }
      ctx.drawImage(
        img,
        (tileId % cols) * cellWidth,
        Math.floor(tileId / cols) * cellHeight,
        cellWidth,
        cellHeight,
        0,
        0,
        cellWidth,
        cellHeight,
      );
      this._images[imgId].urlCache[tileId] = canvas.toDataURL('image/jpeg');
      dataUrl = this._images[imgId].urlCache[tileId];
    }

    const rowEl = rows.children[row];
    if (rowEl) {
      const colEl = rowEl.children[col];
      if (colEl) {
        colEl.textContent = ' ';
        colEl.style.backgroundImage = `url('${dataUrl}')`;
        colEl.style.overflow = 'hidden';
      }
    }

  }

  private _drawToCanvas(imgId: number, tileId: number, col: number, row: number): void {
    const internalTerm = (this._terminal as any)._core;

    // shamelessly draw on foreign canvas for now
    // FIXME: needs own layer
    const ctx: CanvasRenderingContext2D = internalTerm.renderer._renderLayers[0]._ctx;

    this._rescale(imgId);
    const img = this._images[imgId].actual;
    const {width: cellWidth, height: cellHeight} = this._cellSize;
    const cols = Math.ceil(img.width / cellWidth);

    ctx.drawImage(
      img,
      (tileId % cols) * cellWidth,
      Math.floor(tileId / cols) * cellHeight,
      cellWidth,
      cellHeight,
      col * cellWidth,
      row * cellHeight,
      cellWidth,
      cellHeight,
    );
  }
}

class SIXEL implements IDcsHandler {
  private _image: SixelImage = new SixelImage();

  constructor(private _store: ImageStorage) {}

  hook(collect: string, params: number[], flag: number): void {
    /**
     * We only care for P2 - from the docs:
     * P2 selects how the terminal draws the background color. You can use one of three values.
     *    0 or 2 (default) 	Pixel positions specified as 0 are set to the current background color.
     *    1 	              Pixel positions specified as 0 remain at their current color.
     * @see: https://vt100.net/docs/vt3xx-gp/chapter14.html
     */

    // a fill color of 0 indicates to keep empty pixels transparent
    // any other will apply current BG color in this._store.addImageFromSixel
    if (params[1] && params[1] === 1) {
      this._image.fillColor = 0;
    }
  }

  put(data: Uint32Array, start: number, end: number): void {
    this._image.write(data, start, end);
    // we dont propagate partially transmitted images to the terminal
  }

  unhook(): void {
    // propagate the full image to terminal
    this._store.addImageFromSixel(this._image);

    // reset image to free memory
    this._image = new SixelImage();
  }
}

const FIELD_PARSER: {[key: string]: (data: string) => any} = {
  name: (data: string) => atob(data),
  size: parseInt,
  width: (data: string) => data,
  height: (data: string) => data,
  preserveAspectRatio: parseInt,
  inline: parseInt
}

export class SixelAddon implements ITerminalAddon {
  private _imageHandler: IDisposable | null = null;
  public activate(terminal: Terminal): void {
    const imageStorage = new ImageStorage(terminal);

    // missing terminal.addDcsHandler
    // thus patch internally for now
    const _term: any = (terminal as any)._core;
    (_term._inputHandler as any)._parser.setDcsHandler('q', new SIXEL(imageStorage));

    // other image formats
    // use iTerm style for now
    // FIXME in xterm.js - rework osc handler with a DCS handler like interface:
    //  --> explicit hook/unhook, eating chunks of bytes
    this._imageHandler = terminal.addOscHandler(1337, data => {
      // skip File=
      const start = (data.startsWith('File=')) ? 5 : 0;
      const divider = data.indexOf(':');
      if (divider === -1) {
        return false;
      }
      // extract header fields
      const entries = data.slice(start, divider).split(';').reduce(
        (accu: {[key: string]: string | number}, current) => {
          const [key, value] = current.split('=');
          accu[key] = (FIELD_PARSER[key]) ? FIELD_PARSER[key](value) : value;
          return accu;
        }, {name: 'Unnamed file', preserveAspectRatio: 1, inline: 0}
      );

      // dont handle file downloads
      if (!entries.inline) {
        return false;
      }
      console.log(entries);
      
      const payload = new Uint8Array(data.length);
      for (let i = 0; i < data.length; ++i) {
        payload[i] = data.charCodeAt(i);
      }

      // determine image format and pixel size
      const size = ImageSize.guessFormat(payload.subarray(divider + 1), true);
      if (size.type === ImageType.INVALID || size.width === -1 || size.height === -1) {
        return false;
      }

      // store image in ImageStorage
      imageStorage.addImageFromBase64(payload.subarray(divider + 1), size);
      return true;
    });

    terminal.onRender(imageStorage.render.bind(imageStorage));
  }

  public dispose(): void {
    if (this._imageHandler) {
      this._imageHandler.dispose();
      this._imageHandler = null;
    }
  }
}
