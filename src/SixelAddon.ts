/**
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * @license MIT
 *
 * Implements SIXEL support.
 */

import { Terminal, IDisposable } from 'xterm';
import { SixelImage, toRGBA8888 } from 'sixel';

interface ISixelOptions {
  // whether to rescale with cell size changes
  rescale?: boolean;
  // whether to reflow with terminal size changes - unlikely
  reflow?: boolean;
}

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

interface BufferCoord {
  col: number;
  row: number;
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
}

/**
 * Image Storage
 * 
 * TODO: add markers for lifecycle management
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

  /**
   * Method to add an image to the storage.
   * Does all the needed low level stuff to tile the image data correctly
   * onto the terminal buffer cells.
   */
  public addImage(img: HTMLCanvasElement): void {
    /**
     * Initial img setup:
     * - translate img size into current rows x cols
     * - make room in buffer
     * - create markers
     */
    this._images.push({
      orig: img,
      origCellSize: this._cellSize,
      actual: img,
      actualCellSize: this._cellSize
    });

    // calc rows x cols needed to display the image
    const cols = Math.ceil(img.width / this._cellSize.width);
    const rows = Math.ceil(img.height / this._cellSize.height);

    // write placeholder into terminal buffer
    // what is a good placeholder? - code: 0x110000, width: 1, flag: INVISIBLE FG: image idx, BG: tile number
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

    
    
    // debug
    //document.body.appendChild(document.createElement('br'));
    //document.body.appendChild(img);
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

  public render(e: {start: number, end: number}): void {
    const {start, end} = e;
    const internalTerm = (this._terminal as any)._core;
    const buffer = internalTerm.buffer;
    
    // walk all cells in viewport and draw tile if needed
    for (let row = start; row < end; ++row) {
      const bufferRow = buffer.lines.get(row + buffer.ydisp);
      for (let col = 0; col < internalTerm.cols; ++col) {
        if (bufferRow.getCodePoint(col) === CODE) {
          const fg = bufferRow.getFg(col);
          if (fg & INVISIBLE) {
            this._drawTile(fg & 0xFFFFFF, bufferRow.getBg(col) & 0xFFFFFF, col, row);
          }
        }
      }
    }
  }

  private _drawTile(imgId: number, tileId: number, col: number, row: number): void {
    const internalTerm = (this._terminal as any)._core;

    // shamelessly draw on foreign canvas for now
    // FIXME: needs own layer
    const ctx: CanvasRenderingContext2D = internalTerm.renderer._renderLayers[0]._ctx;

    const img = this._images[imgId].actual;

    const cols = Math.ceil(img.width / this._cellSize.width);

    const tileX = tileId % cols;
    const tileY = Math.floor(tileId / cols);

    // void ctx.drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight);
    ctx.drawImage(
      img,
      tileX * this._cellSize.width,
      tileY * this._cellSize.height,
      this._cellSize.width,
      this._cellSize.height,
      col * this._cellSize.width,
      row * this._cellSize.height,
      this._cellSize.width,
      this._cellSize.height,
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

export class SixelAddon implements ITerminalAddon {
  constructor(options?: ISixelOptions) {}

  public activate(terminal: Terminal): void {
    const imageStorage = new ImageStorage(terminal);

    // missing terminal.addDcsHandler
    // thus patch internally for now
    const _term: any = (terminal as any)._core;
    (_term._inputHandler as any)._parser.setDcsHandler('q', new SIXEL(imageStorage));

    terminal.onRender(imageStorage.render.bind(imageStorage));
  }

  public dispose(): void {}
}
