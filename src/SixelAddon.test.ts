/**
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import * as puppeteer from 'puppeteer';
import { assert } from 'chai';
import { ITerminalOptions } from 'xterm';
import WebSocket = require('ws');
import * as fs from 'fs';

const APP = 'http://127.0.0.1:3000';

let browser: puppeteer.Browser;
let page: puppeteer.Page;
const width = 800;
const height = 600;

const SIXEL_TEST = '\x1bPq#0;2;0;0;0#1;2;100;100;0#2;2;0;100;0#1~~@@vv@@~~@@~~$#2??}}GG}}??}}??-#1!14@\x1b\\';
//const SIXEL_TEST = '\x1b[31m jojo';

describe('Sixel support', () => {
  before(async function(): Promise<any> {
    this.timeout(10000);
    browser = await puppeteer.launch({
      headless: process.argv.indexOf('--headless') !== -1,
      slowMo: 80,
      args: [`--window-size=${width},${height}`]
    });
    page = (await browser.pages())[0];
    await page.setViewport({ width, height });
  });

  after(async () => {
    await browser.close();
  });

  beforeEach(async function(): Promise<any> {
    this.timeout(5000);
    await page.goto(APP);
  });

  it('yay', async function(): Promise<any> {
    this.timeout(60000);
    await openTerminal({ rendererType: 'canvas' });
    const port = 8080;
    const server = new WebSocket.Server({ port });
    server.on('connection', socket => socket.send('foo'));

    // load addon
    await page.evaluate(`
      window.term.loadAddon(new window.SixelAddon());
    `);

    // wikipedia example
    page.evaluate(data => {
      (window as any).term.write('Hi:\r\n' + data);
    }, SIXEL_TEST);

    // gnuplot demo file
    page.evaluate(data => {
      (window as any).term.write('\r\ngnuplot:\r\n' + data);
    }, fs.readFileSync('./gnuplot.six', {encoding: 'ascii'}));

    // boticelli demo file
    page.evaluate(data => {
      (window as any).term.write('\r\nboticelli:\r\n' + data);
    }, fs.readFileSync('./boticelli.six', {encoding: 'ascii'}));

    await new Promise(resolve => setTimeout(() => resolve, 60000));
    server.close();
  });
});

async function openTerminal(options: ITerminalOptions = {}): Promise<void> {
  await page.evaluate(`window.term = new Terminal(${JSON.stringify(options)})`);
  await page.evaluate(`window.term.open(document.querySelector('#terminal'))`);
  if (options.rendererType === 'dom') {
    await page.waitForSelector('.xterm-rows');
  } else {
    await page.waitForSelector('.xterm-text-layer');
  }
}