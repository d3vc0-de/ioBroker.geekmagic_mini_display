'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

class GeekmagicMiniDisplay extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'geekmagic_mini_display',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.renderInterval = null;
    }

    async onReady() {
        this.log.info('Starting GeekMagic Mini Display adapter...');

        if (!this.config.ipAddress) {
            this.log.warn('No IP address configured. Please check adapter settings.');
            return;
        }

        // Global states
        await this.setObjectNotExistsAsync('brightness', {
            type: 'state',
            common: { name: 'Brightness', type: 'number', role: 'level.brightness', read: true, write: true, min: 0, max: 100, unit: '%' },
            native: {},
        });
        await this.setObjectNotExistsAsync('info.connection', {
            type: 'state',
            common: { name: 'Connection Status', type: 'boolean', role: 'indicator.connected', read: true, write: false },
            native: {},
        });

        // Initialize Layout Objects
        await this.createLayoutObjects();

        this.subscribeStates('*');

        // Initial connection check & render
        this.checkConnection();
        this.connectionInterval = setInterval(() => this.checkConnection(), 60000);

        // Auto-Update every 5 minutes if something changed (or just periodic)
        this.renderInterval = setInterval(() => this.renderGrid(), 300000);
    }

    async createLayoutObjects() {
        const layout = this.config.layout || '1x1';
        let cells = 1;
        if (layout === '2x2') cells = 4;
        if (layout === '3x3') cells = 9;

        for (let i = 1; i <= cells; i++) {
            const cellPath = `cell${i}`;
            await this.setObjectNotExistsAsync(`${cellPath}.text`, {
                type: 'state',
                common: { name: `Cell ${i} Text`, type: 'string', role: 'text', read: true, write: true, def: '' },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${cellPath}.value`, {
                type: 'state',
                common: { name: `Cell ${i} Value`, type: 'string', role: 'text', read: true, write: true, def: '' },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${cellPath}.unit`, {
                type: 'state',
                common: { name: `Cell ${i} Unit`, type: 'string', role: 'text', read: true, write: true, def: '' },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${cellPath}.chartData`, {
                type: 'state',
                common: { name: `Cell ${i} Chart Data (JSON Array)`, type: 'string', role: 'json', read: true, write: true, def: '[]' },
                native: {},
            });
        }
    }

    async renderGrid() {
        const layout = this.config.layout || '1x1';
        const image = new Jimp(240, 240, 0x000000FF); // Black background
        const fontSmall = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
        const fontMedium = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);

        let cellSize = 240;
        let cols = 1;
        if (layout === '2x2') { cellSize = 120; cols = 2; }
        if (layout === '3x3') { cellSize = 80; cols = 3; }

        const cellsCount = cols * cols;

        for (let i = 1; i <= cellsCount; i++) {
            const x = ((i - 1) % cols) * cellSize;
            const y = Math.floor((i - 1) / cols) * cellSize;

            const text = await this.getStateAsync(`cell${i}.text`);
            const value = await this.getStateAsync(`cell${i}.value`);
            const unit = await this.getStateAsync(`cell${i}.unit`);
            const chartData = await this.getStateAsync(`cell${i}.chartData`);

            // Draw Background Border for Grid
            if (layout !== '1x1') {
                for (let px = 0; px < cellSize; px++) {
                    image.setPixelColor(0x333333FF, x + px, y); // Top border
                    image.setPixelColor(0x333333FF, x, y + px); // Left border
                }
            }

            // Draw Value
            if (value && value.val) {
                const displayValue = value.val.toString() + (unit && unit.val ? ' ' + unit.val : '');
                const currentFont = layout === '3x3' ? fontSmall : fontMedium;
                image.print(currentFont, x + 5, y + (cellSize / 3), {
                    text: displayValue,
                    alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
                    alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE
                }, cellSize - 10, cellSize / 3);
            }

            // Draw Label (Text)
            if (text && text.val) {
                image.print(fontSmall, x + 2, y + 2, {
                    text: text.val.toString(),
                    alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER
                }, cellSize - 4, 20);
            }

            // Draw Sparkline Graph if data exists
            if (chartData && chartData.val) {
                try {
                    const data = JSON.parse(chartData.val.toString());
                    if (Array.isArray(data) && data.length > 1) {
                        this.drawSparkline(image, data, x + 5, y + cellSize - 25, cellSize - 10, 20);
                    }
                } catch (e) {
                    this.log.error(`Error parsing chart data for cell ${i}: ${e.message}`);
                }
            }
        }

        const buffer = await image.getBufferAsync(Jimp.MIME_JPEG);
        await this.pushToDisplay(buffer);
    }

    drawSparkline(image, data, x, y, width, height) {
        const min = Math.min(...data);
        const max = Math.max(...data);
        const range = max - min || 1;

        for (let i = 0; i < data.length - 1; i++) {
            const x1 = x + (i * (width / (data.length - 1)));
            const y1 = y + height - ((data[i] - min) / range) * height;
            const x2 = x + ((i + 1) * (width / (data.length - 1)));
            const y2 = y + height - ((data[i + 1] - min) / range) * height;

            // Simple line drawing (pixel by pixel approximation for Jimp)
            this.drawLine(image, Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2), 0x00FF00FF);
        }
    }

    drawLine(image, x0, y0, x1, y1, color) {
        const dx = Math.abs(x1 - x0);
        const dy = Math.abs(y1 - y0);
        const sx = (x0 < x1) ? 1 : -1;
        const sy = (y0 < y1) ? 1 : -1;
        let err = dx - dy;

        while (true) {
            image.setPixelColor(color, x0, y0);
            if ((x0 === x1) && (y0 === y1)) break;
            const e2 = 2 * err;
            if (e2 > -dy) { err -= dy; x0 += sx; }
            if (e2 < dx) { err += dx; y0 += sy; }
        }
    }

    async pushToDisplay(buffer) {
        try {
            const ip = this.config.ipAddress;
            const form = new FormData();
            form.append('file', buffer, { filename: '0.jpg', contentType: 'image/jpeg' });
            const url = `http://${ip}/doUpload?dir=%2Fimage%2F`;
            await axios.post(url, form, { headers: { ...form.getHeaders() }, timeout: 5000 });
            this.log.debug('Display updated successfully');
        } catch (error) {
            this.log.error(`Display push failed: ${error.message}`);
        }
    }

    async checkConnection() {
        try {
            await axios.get(`http://${this.config.ipAddress}/`, { timeout: 5000 });
            await this.setStateAsync('info.connection', { val: true, ack: true });
        } catch (error) {
            await this.setStateAsync('info.connection', { val: false, ack: true });
        }
    }

    async onStateChange(id, state) {
        if (!state || state.ack) return;

        if (id.endsWith('.brightness')) {
            try {
                await axios.get(`http://${this.config.ipAddress}/bright?value=${state.val}`);
                await this.setStateAsync(id, { val: state.val, ack: true });
            } catch (error) {
                this.log.error(`Failed to set brightness: ${error.message}`);
            }
        } else {
            // For any other change (cell value, etc.), trigger re-render
            // We use a small debounce or just render immediately
            await this.renderGrid();
            await this.setStateAsync(id, { val: state.val, ack: true });
        }
    }

    onUnload(callback) {
        try {
            if (this.connectionInterval) clearInterval(this.connectionInterval);
            if (this.renderInterval) clearInterval(this.renderInterval);
            callback();
        } catch (error) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new GeekmagicMiniDisplay(options);
} else {
    new GeekmagicMiniDisplay();
}
