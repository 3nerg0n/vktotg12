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
            lastUpdate: null,
            lastPostId: 0 // Добавляем отслеживание последнего поста
        };
        this.vkPollingInterval = null;
        
        console.log('🔄 Инициализация бота...');
    }
    
    async initializeBots() {
        try {
            // Инициализация VK API
            this.vk = new VK({
                token: process.env.VK_TOKEN
            });
            
            // Инициализация только контроллера - основной бот не нужен для получения сообщений
            this.controllerBot = new Telegraf(process.env.TG_CONTROLLER_TOKEN, {
                telegram: { 
                    agent: null, 
                    attachmentAgent: null 
                }
            });
            
            // Обработка ошибок контроллера
            this.controllerBot.catch((err, ctx) => {
                console.error(`❌ Ошибка бота-контроллера:`, err);
            });
            
            console.log('✅ Боты инициализированы');
            return true;
        } catch (error) {
            console.error('❌ Ошибка инициализации ботов:', error);
            return false;
        }
    }
    
    async start() {
        if (this.isRunning) {
            console.log('⚠️ Бот уже запущен');
            return;
        }
        
        try {
            console.log('🚀 Запуск VK-Telegram бота...');
            
            // Инициализируем ботов
            const initialized = await this.initializeBots();
            if (!initialized) {
                throw new Error('Не удалось инициализировать ботов');
            }
            
            this.stats.startTime = new Date();
            this.stats.lastUpdate = new Date();
            this.isRunning = true;
            
            // Запускаем только контроллер
            try {
                await this.controllerBot.launch({
                    dropPendingUpdates: true,
                    allowedUpdates: ['message']
                });
                console.log('✅ Бот-контроллер запущен');
            } catch (controllerError) {
                console.error('❌ Ошибка запуска бота-контроллера:', controllerError.message);
                throw controllerError;
            }
            
            // Настройка команд контроллера
            this.setupControllerCommands();
            
            // Настройка VK слушателя
            await this.setupVKListener();
            
            console.log('🎉 Бот успешно запущен и готов к работе');
            
        } catch (error) {
            console.error('💥 Критическая ошибка запуска бота:', error);
            await this.cleanup();
            throw error;
        }
    }
    
    async setupVKListener() {
        try {
            // Проверяем доступность VK API
            const groupId = process.env.VK_GROUP_ID;
            if (!groupId) {
                console.warn('⚠️ VK_GROUP_ID не установлен, VK мониторинг отключен');
                return;
            }
            
            const groups = await this.vk.api.groups.getById({
                group_ids: groupId
            });
            
            console.log('✅ VK API подключен. Группа:', groups[0]?.name || 'Неизвестно');
            
            // Получаем последний пост для установки начального ID
            await this.initializeLastPostId();
            
            // Запускаем мониторинг VK
            this.startVKPolling();
            
        } catch (error) {
            console.error('❌ Ошибка настройки VK слушателя:', error.message);
            console.log('⚠️ Продолжаем работу без VK мониторинга');
        }
    }
    
    async initializeLastPostId() {
        try {
            const groupId = process.env.VK_GROUP_ID;
            const posts = await this.vk.api.wall.get({
                owner_id: -Math.abs(parseInt(groupId)),
                count: 1,
                filter: 'owner'
            });
            
            if (posts.items.length > 0) {
                this.stats.lastPostId = posts.items[0].id;
                console.log(`📝 Установлен последний пост ID: ${this.stats.lastPostId}`);
            } else {
                this.stats.lastPostId = 0;
                console.log('📝 В группе нет постов, начинаем мониторинг с нуля');
            }
        } catch (error) {
            console.error('❌ Ошибка инициализации последнего поста:', error.message);
            this.stats.lastPostId = 0;
        }
    }
    
    startVKPolling() {
        console.log('🔄 Запуск опроса стены VK...');
        
        // Останавливаем предыдущий интервал если есть
        if (this.vkPollingInterval) {
            clearInterval(this.vkPollingInterval);
        }
        
        this.vkPollingInterval = setInterval(async () => {
            if (!this.isRunning) {
                console.log('⏸️ Бот остановлен, прекращаем опрос VK');
                return;
            }
            
            try {
                const groupId = process.env.VK_GROUP_ID;
                if (!groupId) {
                    console.log('⚠️ VK_GROUP_ID не установлен, пропускаем опрос');
                    return;
                }
                
                console.log('🔍 Проверяем новые посты в VK...');
                
                const posts = await this.vk.api.wall.get({
                    owner_id: -Math.abs(parseInt(groupId)),
                    count: 10,
                    filter: 'owner'
                });
                
                console.log(`📝 Получено постов: ${posts.items.length}`);
                this.stats.lastUpdate = new Date();
                
                // Обрабатываем новые посты
                const newPosts = await this.processNewVKPosts(posts.items);
                
                if (newPosts > 0) {
                    console.log(`✅ Обработано новых постов: ${newPosts}`);
                } else {
                    console.log('📭 Новых постов не найдено');
                }
                
            } catch (error) {
                console.error('❌ Ошибка при опросе VK:', error.message);
            }
        }, 30000); // Проверка каждые 30 секунд для тестирования
    }
    
    async processNewVKPosts(posts) {
        let newPostsCount = 0;
        
        // Сортируем посты по ID (от новых к старым)
        const sortedPosts = posts.sort((a, b) => b.id - a.id);
        
        for (const post of sortedPosts) {
            // Проверяем, новый ли это пост
            if (post.id > this.stats.lastPostId) {
                console.log(`🆕 Найден новый пост ID: ${post.id} (предыдущий: ${this.stats.lastPostId})`);
                
                // Обновляем последний ID
                this.stats.lastPostId = post.id;
                
                // Проверяем наличие фото
                if (post.attachments) {
                    const photos = post.attachments.filter(att => att.type === 'photo');
                    
                    if (photos.length > 0) {
                        console.log(`📸 В посте ${post.id} найдено ${photos.length} фото`);
                        
                        try {
                            await this.sendPhotosToTelegram(photos, post);
                            this.stats.photosSent += photos.length;
                            console.log(`✅ Фото из поста ${post.id} отправлены в Telegram`);
                        } catch (error) {
                            console.error(`❌ Ошибка отправки фото из поста ${post.id}:`, error.message);
                        }
                    } else {
                        console.log(`📄 Пост ${post.id} без фото, пропускаем`);
                    }
                } else {
                    console.log(`📄 Пост ${post.id} без вложений, пропускаем`);
                }
                
                newPostsCount++;
                
                // Добавляем задержку между обработкой постов
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        return newPostsCount;
    }
    
    async sendPhotosToTelegram(photos, post) {
        try {
            const channelId = process.env.TG_CHANNEL_ID;
            if (!channelId) {
                throw new Error('TG_CHANNEL_ID не установлен');
            }
            
            // Отправляем первое фото с описанием
            const firstPhoto = photos[0];
            const largestPhoto = firstPhoto.photo.sizes.reduce((largest, size) => {
                return (size.width > largest.width) ? size : largest;
            });
            
            const photoUrl = largestPhoto.url;
            const postText = post.text ? post.text.substring(0, 200) + '...' : 'Новый пост';
            
            await this.controllerBot.telegram.sendPhoto(
                channelId,
                photoUrl,
                {
                    caption: `📸 Новый пост из VK\n\n${postText}\n\n⏰ ${new Date(post.date * 1000).toLocaleString('ru-RU')}`
                }
            );
            
            console.log('✅ Первое фото отправлено в Telegram');
            
            // Если есть дополнительные фото, отправляем их без описания
            if (photos.length > 1) {
                for (let i = 1; i < photos.length; i++) {
                    const photo = photos[i];
                    const largestAdditional = photo.photo.sizes.reduce((largest, size) => {
                        return (size.width > largest.width) ? size : largest;
                    });
                    
                    await this.controllerBot.telegram.sendPhoto(
                        channelId,
                        largestAdditional.url
                    );
                    
                    console.log(`✅ Дополнительное фото ${i + 1}/${photos.length} отправлено`);
                    
                    // Задержка между отправками
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
            
        } catch (error) {
            console.error('❌ Ошибка отправки в Telegram:', error.message);
            throw error;
        }
    }
    
    setupControllerCommands() {
        // Команды для бота-контроллера
        this.controllerBot.command('start', (ctx) => {
            ctx.reply('🤖 Бот контроллер активен!\nИспользуйте /status для проверки состояния');
        });
        
        this.controllerBot.command('status', (ctx) => {
            if (ctx.from.id.toString() === process.env.TG_ADMIN_ID) {
                const status = this.getStatus();
                ctx.reply(
                    `📊 Статус системы:\n` +
                    `🤖 Бот: ${status.isRunning ? '🟢 Запущен' : '🔴 Остановлен'}\n` +
                    `📸 Фото отправлено: ${status.photosSent}\n` +
                    `⏱️ Время работы: ${status.uptime}\n` +
                    `🕒 Последняя проверка: ${status.lastUpdate}\n` +
                    `📝 Последний пост ID: ${status.lastPostId}`
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
        
        this.controllerBot.command('test', async (ctx) => {
            if (ctx.from.id.toString() === process.env.TG_ADMIN_ID) {
                try {
                    await this.testVKConnection();
                    ctx.reply('✅ Тест подключения к VK выполнен успешно');
                } catch (error) {
                    ctx.reply('❌ Ошибка теста VK: ' + error.message);
                }
            }
        });
        
        console.log('✅ Команды контроллера настроены');
    }
    
    async testVKConnection() {
        try {
            const groupId = process.env.VK_GROUP_ID;
            if (!groupId) {
                throw new Error('VK_GROUP_ID не установлен');
            }
            
            const groups = await this.vk.api.groups.getById({
                group_ids: groupId
            });
            
            const posts = await this.vk.api.wall.get({
                owner_id: -Math.abs(parseInt(groupId)),
                count: 3
            });
            
            console.log('✅ Тест VK: Успешно');
            console.log(`   Группа: ${groups[0]?.name}`);
            console.log(`   Последних постов: ${posts.items.length}`);
            console.log(`   Последний пост ID: ${posts.items[0]?.id}`);
            
            return true;
        } catch (error) {
            console.error('❌ Тест VK: Ошибка', error.message);
            throw error;
        }
    }
    
    async stop() {
        if (!this.isRunning) {
            console.log('⚠️ Бот уже остановлен');
            return;
        }
        
        try {
            console.log('🛑 Остановка бота...');
            this.isRunning = false;
            
            // Останавливаем VK polling
            if (this.vkPollingInterval) {
                clearInterval(this.vkPollingInterval);
                this.vkPollingInterval = null;
                console.log('✅ VK мониторинг остановлен');
            }
            
            // Корректно останавливаем контроллер
            if (this.controllerBot) {
                try {
                    await this.controllerBot.stop();
                    console.log('✅ Бот-контроллер остановлен');
                } catch (error) {
                    console.error('❌ Ошибка остановки контроллера:', error.message);
                }
            }
            
            await this.cleanup();
            console.log('✅ Бот полностью остановлен');
            
        } catch (error) {
            console.error('❌ Ошибка остановки бота:', error);
            await this.cleanup();
            throw error;
        }
    }
    
    async cleanup() {
        this.isRunning = false;
        
        if (this.vkPollingInterval) {
            clearInterval(this.vkPollingInterval);
            this.vkPollingInterval = null;
        }
        
        // Очищаем ссылки
        this.controllerBot = null;
        this.vk = null;
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
                this.stats.lastUpdate.toLocaleTimeString('ru-RU') : 'Нет данных',
            lastPostId: this.stats.lastPostId || 0
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
                await new Promise(resolve => setTimeout(resolve, 3000));
                await bot.start();
                res.json({ success: true, message: 'Бот перезапущен' });
                break;
            case 'test':
                await bot.testVKConnection();
                res.json({ success: true, message: 'Тест выполнен успешно' });
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

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('🛑 Получен SIGINT, останавливаем бота...');
    await bot.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('🛑 Получен SIGTERM, останавливаем бота...');
    await bot.stop();
    process.exit(0);
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
