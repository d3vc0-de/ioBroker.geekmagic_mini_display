'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const FormData = require('form-data');
const Jimp = require('jimp');

class GeekmagicMiniDisplay extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'geekmagic_mini_display' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.currentWidgets = [];
        this.dirtySlots = new Set();
    }

    async onReady() {
        this.log.info('Starting GeekMagic Mini Display (True Gradient Widgets)...');
        if (!this.config.ipAddress) return;
        await this.refreshConfig();
        for (const w of this.currentWidgets) {
            if (w.enabled && w.oid) await this.subscribeForeignStatesAsync(w.oid);
        }
        await this.setObjectNotExistsAsync('info.connection', {
            type: 'state',
            common: { name: 'Connection Status', type: 'boolean', role: 'indicator.connected', read: true, write: false },
            native: {},
        });
        this.checkConnection();
        this.connectionInterval = setInterval(() => this.checkConnection(), 60000);
        await this.renderAllScreens();
        const intervalMs = (parseInt(this.config.updateInterval) || 30) * 1000;
        this.renderInterval = setInterval(() => this.processDirtySlots(), intervalMs);
    }

    async refreshConfig() {
        const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
        if (obj && obj.native && obj.native.widgets) {
            let widgets = obj.native.widgets;
            if (typeof widgets === 'string') {
                try { widgets = JSON.parse(widgets); } catch (e) { widgets = []; }
            }
            this.currentWidgets = Array.isArray(widgets) ? widgets : [];
        }
    }

    async processDirtySlots() {
        if (this.dirtySlots.size === 0) return;
        await this.refreshConfig();
        const slotsToProcess = Array.from(this.dirtySlots);
        this.dirtySlots.clear();
        for (const slotNum of slotsToProcess) {
            const widgetsForSlot = this.currentWidgets.filter(w => w.enabled && (parseInt(w.slot) || 0) === slotNum);
            if (widgetsForSlot.length > 0) {
                await this.renderSlot(slotNum, widgetsForSlot);
                await this.sleep(1500); 
            }
        }
    }

    async renderAllScreens() {
        await this.refreshConfig();
        const activeSlots = new Set();
        const slots = {};
        for (const w of this.currentWidgets) {
            if (!w.enabled) continue;
            const sNum = parseInt(w.slot) || 0;
            if (!slots[sNum]) slots[sNum] = [];
            slots[sNum].push(w);
            activeSlots.add(sNum);
        }
        for (const slotNum in slots) {
            await this.renderSlot(parseInt(slotNum), slots[slotNum]);
            await this.sleep(1500);
        }
    }

    async renderSlot(slotNum, widgets) {
        try {
            const image = await new Promise((resolve, reject) => {
                new Jimp(240, 240, 0x000000FF, (err, img) => {
                    if (err) reject(err); else resolve(img);
                });
            });
            const fontS = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
            const fontM = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
            const is2x2 = widgets.some(w => w.pos !== 'full');
            const cellSize = is2x2 ? 120 : 240;

            for (const w of widgets) {
                let x = 0, y = 0;
                if (is2x2) {
                    if (w.pos === 'tr') x = 120;
                    if (w.pos === 'bl') y = 120;
                    if (w.pos === 'br') { x = 120; y = 120; }
                    for (let p = 0; p < cellSize; p++) {
                        image.setPixelColor(0x222222FF, x + p, y);
                        image.setPixelColor(0x222222FF, x, y + p);
                    }
                }
                let val = 0;
                if (w.oid) {
                    const state = await this.getForeignStateAsync(w.oid);
                    if (state && state.val !== null) val = state.val;
                }
                await this.drawWidget(image, x, y, cellSize, w, val, fontS, fontM);
            }
            const buffer = await image.getBufferAsync(Jimp.MIME_JPEG);
            await this.pushToDisplay(buffer, slotNum);
        } catch (error) {
            this.log.error(`[Slot ${slotNum}] Render error: ${error.message}`);
        }
    }

    async drawWidget(image, x, y, size, widget, val, fontS, fontM) {
        const min = widget.min !== undefined ? parseFloat(widget.min.toString().replace(',', '.')) : 0;
        const max = widget.max !== undefined ? parseFloat(widget.max.toString().replace(',', '.')) : 100;
        
        // Single color for text (interpolated based on current value)
        let textColorHex = widget.color || '#00FF00';
        if (widget.useGradient && widget.colorStart && widget.colorEnd) {
            textColorHex = this.interpolateColor(widget.colorStart, widget.colorEnd, val, min, max);
        }
        const textColorInt = parseInt(textColorHex.replace('#', '0x') + 'FF', 16);

        const decimals = widget.decimals !== undefined ? parseInt(widget.decimals) : 1;
        let displayValue = (val !== null && val !== undefined ? (typeof val === 'number' ? val.toFixed(decimals) : val.toString()) : '-') + (widget.unit ? ' ' + widget.unit : '');

        const currentFont = size < 200 ? fontS : fontM;
        if (widget.label) image.print(fontS, x + 2, y + 2, { text: widget.label.toString(), alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, size - 4);

        if (widget.widgetType === 'progress') {
            const barH = size < 200 ? 10 : 20;
            this.drawProgressBar(image, val, min, max, x + 10, y + (size / 2) - 5, size - 20, barH, widget);
            this.printColored(image, currentFont, x + 2, y + (size / 2) + barH + 5, displayValue, size - 4, textColorInt);
        } else if (widget.widgetType === 'gauge') {
            const radius = size / 3.5;
            this.drawGauge(image, val, min, max, x + (size / 2), y + (size / 2) + 10, radius, widget);
            this.printColored(image, currentFont, x + 2, y + (size / 2) + 25, displayValue, size - 4, textColorInt);
        } else if (widget.widgetType === 'circle') {
            const radius = size / 3.5;
            this.drawCircleProgress(image, val, min, max, x + (size / 2), y + (size / 2), radius, widget);
            this.printColored(image, currentFont, x + 2, y + (size / 2) - 10, displayValue, size - 4, textColorInt);
        } else {
            this.printColored(image, currentFont, x + 2, y + (size / 2) - 15, displayValue, size - 4, textColorInt);
        }
    }

    printColored(image, font, x, y, text, width, colorInt) {
        const tempImage = new Jimp(width + 10, 50, 0x00000000);
        tempImage.print(font, 0, 0, { text: text.toString(), alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, width);
        tempImage.scan(0, 0, tempImage.bitmap.width, tempImage.bitmap.height, function(sx, sy, idx) {
            if (this.bitmap.data[idx + 0] > 200) {
                this.bitmap.data[idx + 0] = (colorInt >> 24) & 0xff;
                this.bitmap.data[idx + 1] = (colorInt >> 16) & 0xff;
                this.bitmap.data[idx + 2] = (colorInt >> 8) & 0xff;
            }
        });
        image.blit(tempImage, x, y);
    }

    interpolateColor(startHex, endHex, val, min, max) {
        const ratio = Math.min(Math.max((val - min) / (max - min), 0), 1);
        return this.getColorByRatio(startHex, endHex, ratio);
    }

    getColorByRatio(startHex, endHex, ratio) {
        const parse = (hex) => {
            const h = hex.replace('#', '');
            return { r: parseInt(h.substring(0, 2), 16), g: parseInt(h.substring(2, 4), 16), b: parseInt(h.substring(4, 6), 16) };
        };
        const s = parse(startHex), e = parse(endHex);
        const r = Math.round(s.r + (e.r - s.r) * ratio).toString(16).padStart(2, '0');
        const g = Math.round(s.g + (e.g - s.g) * ratio).toString(16).padStart(2, '0');
        const b = Math.round(s.b + (e.b - s.b) * ratio).toString(16).padStart(2, '0');
        return `#${r}${g}${b}`;
    }

    drawProgressBar(image, value, min, max, x, y, width, height, widget) {
        const percent = Math.min(Math.max((value - min) / (max - min), 0), 1);
        for (let i = 0; i < width; i++) {
            const ratio = i / width;
            const colorHex = (widget.useGradient && widget.colorStart && widget.colorEnd) ? this.getColorByRatio(widget.colorStart, widget.colorEnd, ratio) : widget.color;
            const colorInt = parseInt((colorHex || '#00FF00').replace('#', '0x') + 'FF', 16);
            for (let j = 0; j < height; j++) {
                if (i < width * percent) {
                    image.setPixelColor(colorInt, x + i, y + j);
                } else {
                    image.setPixelColor(0x333333FF, x + i, y + j);
                }
            }
        }
    }

    drawGauge(image, value, min, max, centerX, centerY, radius, widget) {
        const percent = Math.min(Math.max((value - min) / (max - min), 0), 1);
        const startAngle = -Math.PI, thickness = radius / 4;
        for (let t = 0; t < thickness; t++) {
            const r = radius - t;
            for (let a = startAngle; a <= 0; a += 0.02) {
                const angleRatio = (a - startAngle) / Math.PI;
                const isActive = angleRatio <= percent;
                const colorHex = (widget.useGradient && widget.colorStart && widget.colorEnd) ? this.getColorByRatio(widget.colorStart, widget.colorEnd, angleRatio) : widget.color;
                const colorInt = parseInt((colorHex || '#00FF00').replace('#', '0x') + 'FF', 16);
                const px = centerX + Math.cos(a) * r, py = centerY + Math.sin(a) * r;
                image.setPixelColor(isActive ? colorInt : 0x333333FF, Math.round(px), Math.round(py));
            }
        }
    }

    drawCircleProgress(image, value, min, max, centerX, centerY, radius, widget) {
        const percent = Math.min(Math.max((value - min) / (max - min), 0), 1);
        const startAngle = -Math.PI / 2, thickness = radius / 4;
        for (let t = 0; t < thickness; t++) {
            const r = radius - t;
            for (let a = startAngle; a <= startAngle + Math.PI * 2; a += 0.015) {
                const angleRatio = (a - startAngle) / (Math.PI * 2);
                const isActive = angleRatio <= percent;
                const colorHex = (widget.useGradient && widget.colorStart && widget.colorEnd) ? this.getColorByRatio(widget.colorStart, widget.colorEnd, angleRatio) : widget.color;
                const colorInt = parseInt((colorHex || '#00FF00').replace('#', '0x') + 'FF', 16);
                const px = centerX + Math.cos(a) * r, py = centerY + Math.sin(a) * r;
                image.setPixelColor(isActive ? colorInt : 0x333333FF, Math.round(px), Math.round(py));
            }
        }
    }

    async pushToDisplay(buffer, index) {
        try {
            const form = new FormData();
            form.append('file', buffer, { filename: `${index}.jpg`, contentType: 'image/jpeg' });
            const headers = { 'Content-Type': `multipart/form-data; boundary=${form.getBoundary()}` };
            await axios.post(`http://${this.config.ipAddress}/doUpload?dir=%2Fimage%2F`, form.getBuffer(), { headers, timeout: 20000 });
            this.log.info(`[Slot ${index}] Upload successful`);
        } catch (error) {
            if (!error.message.includes('Duplicate Content-Length')) this.log.error(`[Slot ${index}] Push failed: ${error.message}`);
        }
    }

    async deleteFromDisplay(index) {
        try { await axios.get(`http://${this.config.ipAddress}/delete?file=%2Fimage%2F${index}.jpg`, { timeout: 5000 }); } catch (e) {}
    }

    async checkConnection() {
        if (!this.config.ipAddress) return;
        try {
            await axios.get(`http://${this.config.ipAddress}/`, { timeout: 8000 });
            await this.setStateAsync('info.connection', { val: true, ack: true });
        } catch (error) { await this.setStateAsync('info.connection', { val: false, ack: true }); }
    }

    async onStateChange(id, state) {
        if (!state || state.ack) return;
        await this.refreshConfig();
        for (const w of this.currentWidgets) {
            if (w.enabled && w.oid === id) this.dirtySlots.add(parseInt(w.slot) || 0);
        }
    }

    sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
    onUnload(callback) {
        try { if (this.connectionInterval) clearInterval(this.connectionInterval); if (this.renderInterval) clearInterval(this.renderInterval); callback(); } catch (e) { callback(); }
    }
}

if (require.main !== module) {
    module.exports = options => new GeekmagicMiniDisplay(options);
} else {
    new GeekmagicMiniDisplay();
}
