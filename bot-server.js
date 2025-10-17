const express = require('express');
const { Telegraf } = require('telegraf');
const { VK } = require('vk-io');

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
        
        try {
            // Инициализация VK API
            this.vk = new VK({
                token: process.env.VK_TOKEN
            });
            
            // Инициализация Telegram ботов
            this.tgBot = new Telegraf(process.env.TG_TOKEN);
            this.controllerBot = new Telegraf(process.env.TG_CONTROLLER_TOKEN);
            
            console.log('Бот инициализирован');
        } catch (error) {
            console.error('Ошибка инициализации бота:', error);
        }
    }
    
    async start() {
        if (this.isRunning) {
            console.log('Бот уже запущен');
            return;
        }
        
        try {
            console.log('Запуск VK-Telegram бота...');
            this.stats.startTime = new Date();
            this.stats.lastUpdate = new Date();
            this.isRunning = true;
            
            // Настройка VK слушателя
            await this.setupVKListener();
            
            // Запуск Telegram ботов
            await this.tgBot.launch();
            await this.controllerBot.launch();
            
            // Настройка команд контроллера
            this.setupControllerCommands();
            
            console.log('Бот успешно запущен');
        } catch (error) {
            console.error('Ошибка запуска бота:', error);
            this.isRunning = false;
            throw error;
        }
    }
    
    async setupVKListener() {
        try {
            // Проверяем доступность VK API с правильными параметрами
            const groupId = process.env.VK_GROUP_ID;
            if (!groupId) {
                throw new Error('VK_GROUP_ID не установлен');
            }
            
            const groups = await this.vk.api.groups.getById({
                group_ids: groupId // Исправлено: добавлен group_ids
            });
            
            console.log('✅ VK API подключен. Группа:', groups[0]?.name || 'Неизвестно');
            
            // Запускаем мониторинг VK
            this.startVKPolling();
            
        } catch (error) {
            console.error('❌ Ошибка настройки VK слушателя:', error.message);
            
            // Продолжаем работу даже если VK не доступен
            console.log('⚠️  Продолжаем работу без VK мониторинга');
        }
    }
    
    startVKPolling() {
        console.log('🔄 Запуск опроса стены VK...');
        
        // В реальной реализации здесь будет setInterval для проверки новых постов
        setInterval(async () => {
            if (!this.isRunning) return;
            
            try {
                const groupId = process.env.VK_GROUP_ID;
                if (!groupId) {
                    console.log('⚠️  VK_GROUP_ID не установлен, пропускаем опрос');
                    return;
                }
                
                const posts = await this.vk.api.wall.get({
                    owner_id: -Math.abs(parseInt(groupId)),
                    count: 5,
                    filter: 'owner'
                });
                
                console.log(`📝 Проверено постов: ${posts.items.length}`);
                this.stats.lastUpdate = new Date();
                
                // Обрабатываем новые посты с фото
                await this.processVKPosts(posts.items);
                
            } catch (error) {
                console.error('❌ Ошибка при опросе VK:', error.message);
            }
        }, 60000); // Проверка каждую минуту
    }
    
    async processVKPosts(posts) {
        for (const post of posts) {
            // Проверяем, есть ли фото в посте
            if (post.attachments) {
                const photos = post.attachments.filter(att => att.type === 'photo');
                
                if (photos.length > 0) {
                    console.log(`📸 Найдено ${photos.length} фото в посте ${post.id}`);
                    
                    try {
                        await this.sendToTelegram(photos, post);
                        this.stats.photosSent += photos.length;
                        console.log(`✅ Фото из поста ${post.id} отправлены в Telegram`);
                    } catch (error) {
                        console.error(`❌ Ошибка отправки фото из поста ${post.id}:`, error.message);
                    }
                }
            }
        }
    }
    
    async sendToTelegram(photos, post) {
        try {
            for (const photo of photos) {
                // Получаем URL самого большого размера фото
                const largestPhoto = photo.photo.sizes.reduce((largest, size) => {
                    return (size.width > largest.width) ? size : largest;
                });
                
                const photoUrl = largestPhoto.url;
                
                // Отправляем фото в Telegram канал
                await this.tgBot.telegram.sendPhoto(
                    process.env.TG_CHANNEL_ID,
                    photoUrl,
                    {
                        caption: `📸 Новое фото из VK\n⏰ ${new Date(post.date * 1000).toLocaleString('ru-RU')}`
                    }
                );
                
                console.log('✅ Фото отправлено в Telegram');
            }
        } catch (error) {
            console.error('❌ Ошибка отправки в Telegram:', error.message);
            throw error;
        }
    }
    
    setupControllerCommands() {
        // Команды для бота-контроллера
        this.controllerBot.command('start', (ctx) => {
            ctx.reply('🤖 Бот контроллер активен!\\nИспользуйте /status для проверки состояния');
        });
        
        this.controllerBot.command('status', (ctx) => {
            if (ctx.from.id.toString() === process.env.TG_ADMIN_ID) {
                const status = this.getStatus();
                ctx.reply(
                    `📊 Статус системы:\\n` +
                    `🤖 Бот: ${status.isRunning ? '🟢 Запущен' : '🔴 Остановлен'}\\n` +
                    `📸 Фото отправлено: ${status.photosSent}\\n` +
                    `⏱️ Время работы: ${status.uptime}\\n` +
                    `🕒 Последнее обновление: ${status.lastUpdate}`
                );
            } else {
                ctx.reply('❌ У вас нет прав для выполнения этой команды');
            }
        });
        
        this.controllerBot.command('start_bot', async (ctx) => {
            if (ctx.from.id.toString() === process.env.TG_ADMIN_ID) {
                try {
                    await this.start();
                    ctx.reply('✅ Бот успешно запущен');
                } catch (error) {
                    ctx.reply('❌ Ошибка запуска бота: ' + error.message);
                }
            }
        });
        
        this.controllerBot.command('stop_bot', async (ctx) => {
            if (ctx.from.id.toString() === process.env.TG_ADMIN_ID) {
                try {
                    await this.stop();
                    ctx.reply('✅ Бот успешно остановлен');
                } catch (error) {
                    ctx.reply('❌ Ошибка остановки бота: ' + error.message);
                }
            }
        });
        
        console.log('✅ Команды контроллера настроены');
    }
    
    async stop() {
        if (!this.isRunning) {
            console.log('Бот уже остановлен');
            return;
        }
        
        try {
            console.log('🛑 Остановка бота...');
            this.isRunning = false;
            
            await this.tgBot.stop();
            await this.controllerBot.stop();
            
            console.log('✅ Бот остановлен');
        } catch (error) {
            console.error('❌ Ошибка остановки бота:', error);
            throw error;
        }
    }
    
    getStatus() {
        const uptime = this.stats.startTime ? 
            Math.floor((new Date() - this.stats.startTime) / 1000) : 0;
        
        const formatUptime = (seconds) => {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = seconds % 60;
            return `${hours}ч ${minutes}м ${secs}с`;
        };
        
        return {
            isRunning: this.isRunning,
            photosSent: this.stats.photosSent,
            uptime: this.stats.startTime ? formatUptime(uptime) : 'Неактивен',
            lastUpdate: this.stats.lastUpdate ? 
                this.stats.lastUpdate.toLocaleTimeString('ru-RU') : 'Нет данных'
        };
    }
}

// Создаем экземпляр бота
const bot = new VkTelegramBot();

// API endpoints для Cloudflare Worker
app.get('/api/status', (req, res) => {
    try {
        const status = bot.getStatus();
        res.json(status);
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: 'Ошибка получения статуса',
            error: error.message 
        });
    }
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
                await new Promise(resolve => setTimeout(resolve, 2000));
                await bot.start();
                res.json({ success: true, message: 'Бот перезапущен' });
                break;
            default:
                res.status(400).json({ success: false, message: 'Неизвестное действие' });
        }
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

app.get('/api/config', (req, res) => {
    try {
        const config = {
            VK_TOKEN: process.env.VK_TOKEN ? '***' + process.env.VK_TOKEN.slice(-4) : 'Не установлен',
            VK_GROUP_ID: process.env.VK_GROUP_ID || 'Не установлен',
            TG_TOKEN: process.env.TG_TOKEN ? '***' + process.env.TG_TOKEN.slice(-4) : 'Не установлен',
            TG_CHANNEL_ID: process.env.TG_CHANNEL_ID || 'Не установлен',
            TG_USER_ID: process.env.TG_USER_ID || 'Не установлен',
            TG_CONTROLLER_TOKEN: process.env.TG_CONTROLLER_TOKEN ? '***' + process.env.TG_CONTROLLER_TOKEN.slice(-4) : 'Не установлен',
            TG_ADMIN_ID: process.env.TG_ADMIN_ID || 'Не установлен'
        };
        
        res.json(config);
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: 'Ошибка получения конфигурации',
            error: error.message 
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        botRunning: bot.isRunning 
    });
});

// Обработка ошибок
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        success: false, 
        message: 'Внутренняя ошибка сервера' 
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Bot server running on port ${PORT}`);
    console.log(`📊 Health check available at http://localhost:${PORT}/health`);
    console.log(`🔧 API endpoints available at http://localhost:${PORT}/api/`);
});
