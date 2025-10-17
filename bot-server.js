const express = require('express');
const { Telegraf } = require('telegraf');
const VK = require('vk-io');

const app = express();
app.use(express.json());

// Основной бот для VK-Telegram
class VkTelegramBot {
    constructor() {
        this.isRunning = false;
        this.stats = {
            photosSent: 0,
            startTime: null,
            lastUpdate: null
        };
        
        // Инициализация ботов
        this.vk = new VK({
            token: process.env.VK_TOKEN
        });
        
        this.tgBot = new Telegraf(process.env.TG_TOKEN);
        this.controllerBot = new Telegraf(process.env.TG_CONTROLLER_TOKEN);
    }
    
    async start() {
        if (this.isRunning) return;
        
        console.log('Запуск VK-Telegram бота...');
        this.stats.startTime = new Date();
        this.stats.lastUpdate = new Date();
        this.isRunning = true;
        
        // Настройка VK вебхуков
        this.setupVKListener();
        
        // Запуск Telegram ботов
        await this.tgBot.launch();
        await this.controllerBot.launch();
        
        // Настройка команд контроллера
        this.setupControllerCommands();
        
        console.log('Бот успешно запущен');
    }
    
    async stop() {
        if (!this.isRunning) return;
        
        console.log('Остановка бота...');
        this.isRunning = false;
        
        await this.tgBot.stop();
        await this.controllerBot.stop();
        
        console.log('Бот остановлен');
    }
    
    setupVKListener() {
        // Здесь логика мониторинга VK
        console.log('VK listener настроен');
    }
    
    setupControllerCommands() {
        this.controllerBot.command('start', (ctx) => {
            ctx.reply('Бот контроллер активен! Используйте /status для проверки состояния');
        });
        
        this.controllerBot.command('status', (ctx) => {
            if (ctx.from.id.toString() === process.env.TG_ADMIN_ID) {
                const status = this.getStatus();
                ctx.reply(`Статус бота: ${status.isRunning ? '🟢 Запущен' : '🔴 Остановлен'}\n` +
                         `Фото отправлено: ${status.photosSent}\n` +
                         `Время работы: ${status.uptime}`);
            }
        });
    }
    
    getStatus() {
        return {
            isRunning: this.isRunning,
            photosSent: this.stats.photosSent,
            uptime: this.stats.startTime ? 
                Math.floor((new Date() - this.stats.startTime) / 1000) + 'сек' : 'Неактивен',
            lastUpdate: this.stats.lastUpdate
        };
    }
}

const bot = new VkTelegramBot();

// API endpoints для Cloudflare Worker
app.get('/api/status', (req, res) => {
    res.json(bot.getStatus());
});

app.post('/api/control', async (req, res) => {
    const { action } = req.body;
    
    try {
        switch (action) {
            case 'start':
                await bot.start();
                res.json({ success: true, message: 'Бот запущен' });
                break;
            case 'stop':
                await bot.stop();
                res.json({ success: true, message: 'Бот остановлен' });
                break;
            case 'restart':
                await bot.stop();
                await new Promise(resolve => setTimeout(resolve, 1000));
                await bot.start();
                res.json({ success: true, message: 'Бот перезапущен' });
                break;
            default:
                res.status(400).json({ success: false, message: 'Неизвестное действие' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/config', (req, res) => {
    res.json({
        VK_TOKEN: process.env.VK_TOKEN,
        VK_GROUP_ID: process.env.VK_GROUP_ID,
        TG_TOKEN: process.env.TG_TOKEN,
        TG_CHANNEL_ID: process.env.TG_CHANNEL_ID,
        TG_USER_ID: process.env.TG_USER_ID,
        TG_CONTROLLER_TOKEN: process.env.TG_CONTROLLER_TOKEN,
        TG_ADMIN_ID: process.env.TG_ADMIN_ID
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Bot server running on port ${PORT}`);
});
