const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits, Collection, SlashCommandBuilder, REST, Routes } = require('discord.js');
const fs = require('fs-extra');
const path = require('path');

// Bot setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration
    ]
});

// Auto-mod configuration
const SPAM_THRESHOLD = 5; // messages per user in time window
const SPAM_TIME_WINDOW = 10000; // milliseconds
const CAPS_THRESHOLD = 0.7; // percentage of caps in message
const MIN_MESSAGE_LENGTH = 10; // minimum length to check caps
const MAX_MENTIONS = 5; // maximum mentions allowed

// Profanity filter (basic list - can be expanded)
const PROFANITY_WORDS = [
    'spam', 'scam', 'hack', 'free money', 'click here',
    // Add more words as needed
];

// Storage for tracking user activity
const userMessageTimes = new Map();
const userWarnings = new Map();

// Storage for subdomain hosting
const userSubdomains = new Map();

// Common public FreeDNS domains that users can register under
const PUBLIC_DOMAINS = [
    'publicvm.com',
    'my03.com',
    'linkpc.net',
    'ignorelist.com',
    'cloudns.asia',
    'strangled.net',
    'strangled.com',
    'wha.la',
    'freeddns.org',
    'myftp.org',
    'mywebcommunity.org',
    'mywire.org',
    'redirectme.net'
];

// Ensure directories exist
fs.ensureDirSync('sites');

// Slash command definitions
const commands = [
    new SlashCommandBuilder()
        .setName('createsite')
        .setDescription('Register a FreeDNS subdomain for your website')
        .addStringOption(option =>
            option.setName('subdomain')
                .setDescription('Your subdomain name (e.g., "myblog")')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('domain')
                .setDescription('Choose from available public domains')
                .setRequired(true)
                .addChoices(
                    { name: 'publicvm.com', value: 'publicvm.com' },
                    { name: 'my03.com', value: 'my03.com' },
                    { name: 'linkpc.net', value: 'linkpc.net' },
                    { name: 'ignorelist.com', value: 'ignorelist.com' },
                    { name: 'cloudns.asia', value: 'cloudns.asia' },
                    { name: 'strangled.net', value: 'strangled.net' },
                    { name: 'strangled.com', value: 'strangled.com' },
                    { name: 'wha.la', value: 'wha.la' },
                    { name: 'freeddns.org', value: 'freeddns.org' },
                    { name: 'myftp.org', value: 'myftp.org' }
                )
        ),
    new SlashCommandBuilder()
        .setName('mysite')
        .setDescription('View your FreeDNS subdomain information'),
    new SlashCommandBuilder()
        .setName('deletesite')
        .setDescription('Release your FreeDNS subdomain'),
    new SlashCommandBuilder()
        .setName('listsites')
        .setDescription('View all registered FreeDNS subdomains in this server'),
    new SlashCommandBuilder()
        .setName('domains')
        .setDescription('View all available public FreeDNS domains'),
    new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick a member from the server')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to kick')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for kicking')
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban a member from the server')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to ban')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for banning')
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('timeout')
        .setDescription('Timeout a member')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to timeout')
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option.setName('duration')
                .setDescription('Duration in seconds (default: 300)')
                .setRequired(false)
        )
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for timeout')
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Warn a member')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to warn')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for warning')
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('warnings')
        .setDescription('Check warnings for a user')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to check (optional)')
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('clearwarnings')
        .setDescription('Clear warnings for a user')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to clear warnings for')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('purge')
        .setDescription('Delete multiple messages')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('Number of messages to delete (default: 10, max: 100)')
                .setRequired(false)
        )
];

client.once('ready', async () => {
    console.log(`${client.user.tag} has connected to Discord!`);
    console.log('Bot is ready and monitoring for auto-moderation');
    
    // Register slash commands
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
        console.log('Started refreshing application (/) commands.');
        
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
});

client.on('messageCreate', async (message) => {
    // Don't moderate bot messages
    if (message.author.bot) return;

    // Don't moderate if user has admin permissions
    if (message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

    const guild = message.guild;
    const member = message.member;
    
    // Auto-mod checks
    let shouldDelete = false;
    let violationReason = '';
    
    // 1. Spam detection
    if (await checkSpam(message)) {
        shouldDelete = true;
        violationReason = 'spam';
    }
    // 2. Profanity filter
    else if (checkProfanity(message.content)) {
        shouldDelete = true;
        violationReason = 'profanity';
    }
    // 3. Excessive caps
    else if (checkExcessiveCaps(message.content)) {
        shouldDelete = true;
        violationReason = 'excessive caps';
    }
    // 4. Too many mentions
    else if (message.mentions.users.size > MAX_MENTIONS) {
        shouldDelete = true;
        violationReason = 'too many mentions';
    }
    // 5. Invite links (unless user has permissions)
    else if (checkInviteLinks(message.content) && !member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
        shouldDelete = true;
        violationReason = 'unauthorized invite link';
    }
    
    // Take action if violation found
    if (shouldDelete) {
        try {
            await message.delete();
            
            const currentWarnings = userWarnings.get(member.id) || 0;
            userWarnings.set(member.id, currentWarnings + 1);
            const warnings = userWarnings.get(member.id);
            
            // Send warning to user
            const warningEmbed = new EmbedBuilder()
                .setTitle('⚠️ Auto-Moderation Warning')
                .setDescription(`Your message was removed for: **${violationReason}**`)
                .addFields({ name: 'Warnings', value: `${warnings}/3`, inline: true })
                .setColor('#FFA500');
            
            const warningMsg = await message.channel.send({ embeds: [warningEmbed] });
            setTimeout(() => warningMsg.delete().catch(() => {}), 10000);
            
            // Progressive punishment
            if (warnings >= 3) {
                await timeoutUser(member, 5 * 60 * 1000); // 5 minute timeout
                const timeoutEmbed = new EmbedBuilder()
                    .setTitle('🔇 User Timed Out')
                    .setDescription(`${member} has been timed out for 5 minutes (3 warnings)`)
                    .setColor('#FF0000');
                
                const timeoutMsg = await message.channel.send({ embeds: [timeoutEmbed] });
                setTimeout(() => timeoutMsg.delete().catch(() => {}), 15000);
                userWarnings.set(member.id, 0); // Reset warnings after timeout
            }
                
        } catch (error) {
            console.error(`Error in auto-moderation: ${error.message}`);
        }
    }
});

async function checkSpam(message) {
    const userId = message.author.id;
    const currentTime = Date.now();
    
    if (!userMessageTimes.has(userId)) {
        userMessageTimes.set(userId, []);
    }
    
    const messageTimes = userMessageTimes.get(userId);
    messageTimes.push(currentTime);
    
    // Remove old messages outside time window
    const filteredTimes = messageTimes.filter(time => time > currentTime - SPAM_TIME_WINDOW);
    userMessageTimes.set(userId, filteredTimes);
    
    return filteredTimes.length > SPAM_THRESHOLD;
}

function checkProfanity(content) {
    const contentLower = content.toLowerCase();
    return PROFANITY_WORDS.some(word => contentLower.includes(word));
}

function checkExcessiveCaps(content) {
    if (content.length < MIN_MESSAGE_LENGTH) return false;
    
    const capsCount = (content.match(/[A-Z]/g) || []).length;
    const capsRatio = capsCount / content.length;
    
    return capsRatio > CAPS_THRESHOLD;
}

function checkInviteLinks(content) {
    const invitePattern = /discord\.gg\/|discordapp\.com\/invite\//i;
    return invitePattern.test(content);
}

async function timeoutUser(member, duration) {
    try {
        await member.timeout(duration);
    } catch (error) {
        console.error(`Error timing out user: ${error.message}`);
    }
}

// Slash command interaction handler
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
        // Defer reply immediately to prevent timeout
        await interaction.deferReply();
        
        switch (interaction.commandName) {
            case 'kick':
                await handleKickSlash(interaction);
                break;
            case 'ban':
                await handleBanSlash(interaction);
                break;
            case 'timeout':
                await handleTimeoutSlash(interaction);
                break;
            case 'warn':
                await handleWarnSlash(interaction);
                break;
            case 'warnings':
                await handleWarningsSlash(interaction);
                break;
            case 'clearwarnings':
                await handleClearWarningsSlash(interaction);
                break;
            case 'purge':
                await handlePurgeSlash(interaction);
                break;
            case 'createsite':
                await handleCreateSiteSlash(interaction);
                break;
            case 'mysite':
                await handleMySiteSlash(interaction);
                break;
            case 'deletesite':
                await handleDeleteSiteSlash(interaction);
                break;
            case 'listsites':
                await handleListSitesSlash(interaction);
                break;
            case 'domains':
                await handleDomainsSlash(interaction);
                break;
            default:
                await interaction.editReply({ content: '❌ Unknown command.', ephemeral: true });
        }
    } catch (error) {
        console.error(`Slash command error: ${error.message}`);
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ An error occurred while executing the command.', flags: 64 });
            } else if (interaction.deferred && !interaction.replied) {
                await interaction.editReply({ content: '❌ An error occurred while executing the command.' });
            }
        } catch (err) {
            console.error('Failed to respond to interaction:', err.message);
        }
    }
});

async function handleKick(message, args) {
    if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) {
        return message.reply('❌ You don\'t have permission to kick members.');
    }

    const target = message.mentions.members.first();
    if (!target) {
        return message.reply('❌ Please mention a user to kick.');
    }

    const reason = args.slice(1).join(' ') || 'No reason provided';

    try {
        await target.kick(reason);
        const embed = new EmbedBuilder()
            .setTitle('👢 Member Kicked')
            .setDescription(`${target} has been kicked from the server`)
            .addFields(
                { name: 'Reason', value: reason, inline: false },
                { name: 'Moderator', value: message.author.toString(), inline: true }
            )
            .setColor('#FFA500');
        
        await message.channel.send({ embeds: [embed] });
    } catch (error) {
        await message.reply('❌ I don\'t have permission to kick this member.');
    }
}

async function handleBan(message, args) {
    if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) {
        return message.reply('❌ You don\'t have permission to ban members.');
    }

    const target = message.mentions.members.first();
    if (!target) {
        return message.reply('❌ Please mention a user to ban.');
    }

    const reason = args.slice(1).join(' ') || 'No reason provided';

    try {
        await target.ban({ reason });
        const embed = new EmbedBuilder()
            .setTitle('🔨 Member Banned')
            .setDescription(`${target} has been banned from the server`)
            .addFields(
                { name: 'Reason', value: reason, inline: false },
                { name: 'Moderator', value: message.author.toString(), inline: true }
            )
            .setColor('#FF0000');
        
        await message.channel.send({ embeds: [embed] });
    } catch (error) {
        await message.reply('❌ I don\'t have permission to ban this member.');
    }
}

async function handleTimeout(message, args) {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return message.reply('❌ You don\'t have permission to timeout members.');
    }

    const target = message.mentions.members.first();
    if (!target) {
        return message.reply('❌ Please mention a user to timeout.');
    }

    const duration = parseInt(args[1]) || 300; // Default 5 minutes
    const reason = args.slice(2).join(' ') || 'No reason provided';

    try {
        await target.timeout(duration * 1000, reason);
        const embed = new EmbedBuilder()
            .setTitle('🔇 Member Timed Out')
            .setDescription(`${target} has been timed out for ${duration} seconds`)
            .addFields(
                { name: 'Reason', value: reason, inline: false },
                { name: 'Moderator', value: message.author.toString(), inline: true }
            )
            .setColor('#FFFF00');
        
        await message.channel.send({ embeds: [embed] });
    } catch (error) {
        await message.reply('❌ I don\'t have permission to timeout this member.');
    }
}

async function handleWarn(message, args) {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        return message.reply('❌ You don\'t have permission to warn members.');
    }

    const target = message.mentions.members.first();
    if (!target) {
        return message.reply('❌ Please mention a user to warn.');
    }

    const reason = args.slice(1).join(' ') || 'No reason provided';
    
    const currentWarnings = userWarnings.get(target.id) || 0;
    userWarnings.set(target.id, currentWarnings + 1);
    const warnings = userWarnings.get(target.id);

    const embed = new EmbedBuilder()
        .setTitle('⚠️ Warning Issued')
        .setDescription(`${target} has been warned`)
        .addFields(
            { name: 'Reason', value: reason, inline: false },
            { name: 'Warnings', value: `${warnings}/3`, inline: true },
            { name: 'Moderator', value: message.author.toString(), inline: true }
        )
        .setColor('#FFA500');
    
    await message.channel.send({ embeds: [embed] });
    
    // Auto-timeout after 3 warnings
    if (warnings >= 3) {
        await timeoutUser(target, 10 * 60 * 1000); // 10 minute timeout
        const timeoutEmbed = new EmbedBuilder()
            .setTitle('🔇 Auto-Timeout')
            .setDescription(`${target} has been automatically timed out for 10 minutes (3 warnings)`)
            .setColor('#FF0000');
        
        await message.channel.send({ embeds: [timeoutEmbed] });
        userWarnings.set(target.id, 0); // Reset warnings
    }
}

async function handleWarnings(message, args) {
    const target = message.mentions.members.first() || message.member;
    const warnings = userWarnings.get(target.id) || 0;
    
    const embed = new EmbedBuilder()
        .setTitle('📊 Warning Count')
        .setDescription(`${target} has ${warnings} warnings`)
        .setColor('#0099FF');
    
    await message.channel.send({ embeds: [embed] });
}

async function handleClearWarnings(message, args) {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        return message.reply('❌ You don\'t have permission to clear warnings.');
    }

    const target = message.mentions.members.first();
    if (!target) {
        return message.reply('❌ Please mention a user to clear warnings for.');
    }

    userWarnings.set(target.id, 0);
    
    const embed = new EmbedBuilder()
        .setTitle('✅ Warnings Cleared')
        .setDescription(`Cleared all warnings for ${target}`)
        .setColor('#00FF00');
    
    await message.channel.send({ embeds: [embed] });
}

async function handlePurge(message, args) {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        return message.reply('❌ You don\'t have permission to purge messages.');
    }

    const amount = parseInt(args[0]) || 10;
    if (amount > 100) {
        return message.reply('❌ Cannot delete more than 100 messages at once.');
    }

    try {
        const deleted = await message.channel.bulkDelete(amount + 1); // +1 to include command message
        const embed = new EmbedBuilder()
            .setTitle('🧹 Messages Purged')
            .setDescription(`Deleted ${deleted.size - 1} messages`)
            .setColor('#00FF00');
        
        const msg = await message.channel.send({ embeds: [embed] });
        setTimeout(() => msg.delete().catch(() => {}), 5000);
    } catch (error) {
        await message.reply('❌ I don\'t have permission to delete messages.');
    }
}

// Subdomain hosting functions
async function handleCreateSite(message, args) {
    const subdomain = args[0];
    if (!subdomain) {
        const embed = new EmbedBuilder()
            .setTitle('🌐 Create Your Subdomain')
            .setDescription('Create a personal website with your own subdomain!')
            .addFields(
                { name: 'Usage', value: '`!createsite <subdomain>`', inline: false },
                { name: 'Example', value: '`!createsite myblog`', inline: false },
                { name: 'Result', value: 'Creates: yourdomain.myblog.com', inline: false }
            )
            .setColor('#667eea');
        
        return message.channel.send({ embeds: [embed] });
    }

    // Check if user already has a subdomain
    if (userSubdomains.has(message.author.id)) {
        return message.reply('❌ You already have a subdomain! Use `!mysite` to view it or `!deletesite` to delete it first.');
    }

    // Validate subdomain name
    if (!/^[a-zA-Z0-9-]+$/.test(subdomain) || subdomain.length < 3) {
        return message.reply('❌ Invalid subdomain name! Use only letters, numbers, and hyphens (minimum 3 characters).');
    }

    // Check if subdomain is already taken
    const existingSubdomains = Array.from(userSubdomains.values());
    if (existingSubdomains.some(site => site.subdomain === subdomain)) {
        return message.reply('❌ This subdomain is already taken! Please choose a different name.');
    }

    // Create default HTML template
    const defaultHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${message.author.username}'s Website</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: white;
        }
        .container {
            background: rgba(255,255,255,0.1);
            padding: 40px;
            border-radius: 20px;
            backdrop-filter: blur(10px);
        }
        h1 { color: #fff; text-align: center; }
        p { font-size: 18px; line-height: 1.6; }
        .footer { text-align: center; margin-top: 40px; opacity: 0.8; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Welcome to ${message.author.username}'s Website!</h1>
        <p>This is your FreeDNS subdomain: <strong>${subdomain}.${domain}</strong></p>
        <p>This subdomain is registered through FreeDNS. You can point it to your own server or hosting service!</p>
        <div class="footer">
            <p>Created via Discord Bot • ${new Date().toLocaleDateString()}</p>
        </div>
    </div>
</body>
</html>`;

    // Store subdomain data
    const siteData = {
        subdomain: subdomain,
        html: defaultHTML,
        owner: message.author.id,
        created: new Date(),
        visits: 0
    };

    userSubdomains.set(message.author.id, siteData);

    // Save to file
    try {
        fs.writeFileSync(path.join('sites', `${subdomain}.html`), defaultHTML);
    } catch (error) {
        console.error('Error saving site:', error);
    }

    const embed = new EmbedBuilder()
        .setTitle('🎉 Subdomain Created Successfully!')
        .setDescription(`Your personal website is now live!`)
        .addFields(
            { name: '🌐 Your FreeDNS URL', value: `${subdomain}.${domain}`, inline: false },
            { name: '👤 Owner', value: message.author.username, inline: true },
            { name: '📅 Created', value: new Date().toLocaleDateString(), inline: true }
        )
        .setColor('#00FF00')
        .setFooter({ text: 'Use !mysite to view details or !deletesite to remove' });

    await message.channel.send({ embeds: [embed] });
}

async function handleMySite(message, args) {
    const siteData = userSubdomains.get(message.author.id);
    
    if (!siteData) {
        return message.reply('❌ You don\'t have a subdomain yet! Use `!createsite <name>` to create one.');
    }

    const embed = new EmbedBuilder()
        .setTitle('🌐 Your Subdomain Info')
        .setDescription(`Here are the details of your personal website:`)
        .addFields(
            { name: '🌐 FreeDNS URL', value: `${siteData.subdomain}.${siteData.domain}`, inline: false },
            { name: '📅 Created', value: siteData.created.toLocaleDateString(), inline: true },
            { name: '👁️ Visits', value: siteData.visits.toString(), inline: true },
            { name: '💻 Status', value: '🟢 Active', inline: true }
        )
        .setColor('#667eea')
        .setFooter({ text: 'Contact bot owner to update your website content' });

    await message.channel.send({ embeds: [embed] });
}

async function handleDeleteSite(message, args) {
    const siteData = userSubdomains.get(message.author.id);
    
    if (!siteData) {
        return message.reply('❌ You don\'t have a subdomain to delete!');
    }

    // Delete from storage and file
    userSubdomains.delete(message.author.id);
    
    try {
        const filePath = path.join('sites', `${siteData.subdomain}.html`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        console.error('Error deleting site file:', error);
    }

    const embed = new EmbedBuilder()
        .setTitle('🗑️ Subdomain Deleted')
        .setDescription(`Your subdomain **yourdomain.${siteData.subdomain}.com** has been deleted.`)
        .setColor('#FF0000')
        .setFooter({ text: 'You can create a new one anytime with !createsite' });

    await message.channel.send({ embeds: [embed] });
}

async function handleListSites(message, args) {
    if (userSubdomains.size === 0) {
        return message.channel.send('📭 No subdomains have been created yet!');
    }

    const sites = Array.from(userSubdomains.values());
    const siteList = sites.map((site, index) => {
        const user = message.guild.members.cache.get(site.owner);
        const username = user ? user.user.username : 'Unknown User';
        return `${index + 1}. **${site.subdomain}.${site.domain}** - ${username}`;
    }).join('\n');

    const embed = new EmbedBuilder()
        .setTitle('🌐 Active Subdomains')
        .setDescription(siteList)
        .addFields(
            { name: '📊 Total Sites', value: sites.length.toString(), inline: true },
            { name: '📅 Latest', value: sites[sites.length - 1]?.created.toLocaleDateString() || 'None', inline: true }
        )
        .setColor('#667eea')
        .setFooter({ text: 'Use !createsite to create your own subdomain' });

    await message.channel.send({ embeds: [embed] });
}

// Load existing sites on startup
function loadExistingSites() {
    try {
        const sitesDir = path.join(__dirname, 'sites');
        if (fs.existsSync(sitesDir)) {
            const files = fs.readdirSync(sitesDir);
            files.forEach(file => {
                if (file.endsWith('.html')) {
                    const subdomain = file.replace('.html', '');
                    const html = fs.readFileSync(path.join(sitesDir, file), 'utf8');
                    
                    // For existing sites, we don't know the owner, so we'll create a placeholder
                    const siteData = {
                        subdomain: subdomain,
                        html: html,
                        owner: 'unknown',
                        created: new Date(),
                        visits: 0
                    };
                    
                    // We can't map to userSubdomains without knowing the owner
                    console.log(`Loaded existing site: ${subdomain}`);
                }
            });
            console.log(`Loaded ${files.length} existing sites`);
        }
    } catch (error) {
        console.error('Error loading existing sites:', error);
    }
}

// Load sites on bot startup
client.once('ready', () => {
    loadExistingSites();
});

// Slash command versions of all functions
async function handleCreateSiteSlash(interaction) {
    const subdomain = interaction.options.getString('subdomain');
    const domain = interaction.options.getString('domain');
    
    // Check if user already has a subdomain
    if (userSubdomains.has(interaction.user.id)) {
        return interaction.editReply({ content: '❌ You already have a subdomain! Use `/mysite` to view it or `/deletesite` to delete it first.' });
    }

    // Validate subdomain name
    if (!/^[a-zA-Z0-9-]+$/.test(subdomain) || subdomain.length < 3) {
        return interaction.editReply({ content: '❌ Invalid subdomain name! Use only letters, numbers, and hyphens (minimum 3 characters).' });
    }

    // Check if subdomain+domain combination is already taken
    const existingSubdomains = Array.from(userSubdomains.values());
    if (existingSubdomains.some(site => site.subdomain === subdomain && site.domain === domain)) {
        return interaction.editReply({ content: '❌ This subdomain is already taken on this domain! Please choose a different name.' });
    }

    const defaultHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${interaction.user.username}'s Website</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: white;
        }
        .container {
            background: rgba(255,255,255,0.1);
            padding: 40px;
            border-radius: 20px;
            backdrop-filter: blur(10px);
        }
        h1 { color: #fff; text-align: center; }
        p { font-size: 18px; line-height: 1.6; }
        .footer { text-align: center; margin-top: 40px; opacity: 0.8; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Welcome to ${interaction.user.username}'s Website!</h1>
        <p>This is your FreeDNS subdomain: <strong>${subdomain}.${domain}</strong></p>
        <p>This subdomain is registered through FreeDNS. You can point it to your own server or hosting service!</p>
        <div class="footer">
            <p>Created via Discord Bot • ${new Date().toLocaleDateString()}</p>
        </div>
    </div>
</body>
</html>`;

    const siteData = {
        subdomain: subdomain,
        domain: domain,
        html: defaultHTML,
        owner: interaction.user.id,
        created: new Date(),
        visits: 0
    };

    userSubdomains.set(interaction.user.id, siteData);

    try {
        fs.writeFileSync(path.join('sites', `${subdomain}.html`), defaultHTML);
    } catch (error) {
        console.error('Error saving site:', error);
    }

    const embed = new EmbedBuilder()
        .setTitle('🎉 Subdomain Created Successfully!')
        .setDescription(`Your personal website is now live!`)
        .addFields(
            { name: '🌐 Your FreeDNS URL', value: `${subdomain}.${domain}`, inline: false },
            { name: '👤 Owner', value: interaction.user.username, inline: true },
            { name: '📅 Created', value: new Date().toLocaleDateString(), inline: true }
        )
        .setColor('#00FF00')
        .setFooter({ text: 'Use /mysite to view details or /deletesite to remove' });

    await interaction.editReply({ embeds: [embed] });
}

async function handleMySiteSlash(interaction) {
    const siteData = userSubdomains.get(interaction.user.id);
    
    if (!siteData) {
        return interaction.reply({ content: '❌ You don\'t have a subdomain yet! Use `/createsite` to create one.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setTitle('🌐 Your Subdomain Info')
        .setDescription(`Here are the details of your personal website:`)
        .addFields(
            { name: '🌐 FreeDNS URL', value: `${siteData.subdomain}.${siteData.domain}`, inline: false },
            { name: '📅 Created', value: siteData.created.toLocaleDateString(), inline: true },
            { name: '👁️ Visits', value: siteData.visits.toString(), inline: true },
            { name: '💻 Status', value: '🟢 Active', inline: true }
        )
        .setColor('#667eea')
        .setFooter({ text: 'Contact bot owner to update your website content' });

    await interaction.editReply({ embeds: [embed] });
}

async function handleDeleteSiteSlash(interaction) {
    const siteData = userSubdomains.get(interaction.user.id);
    
    if (!siteData) {
        return interaction.reply({ content: '❌ You don\'t have a subdomain to delete!', ephemeral: true });
    }

    userSubdomains.delete(interaction.user.id);
    
    try {
        const filePath = path.join('sites', `${siteData.subdomain}.html`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        console.error('Error deleting site file:', error);
    }

    const embed = new EmbedBuilder()
        .setTitle('🗑️ Subdomain Deleted')
        .setDescription(`Your subdomain **yourdomain.${siteData.subdomain}.com** has been deleted.`)
        .setColor('#FF0000')
        .setFooter({ text: 'You can create a new one anytime with /createsite' });

    await interaction.editReply({ embeds: [embed] });
}

async function handleListSitesSlash(interaction) {
    if (userSubdomains.size === 0) {
        return interaction.reply('📭 No subdomains have been created yet!');
    }

    const sites = Array.from(userSubdomains.values());
    const siteList = sites.map((site, index) => {
        const user = interaction.guild.members.cache.get(site.owner);
        const username = user ? user.user.username : 'Unknown User';
        return `${index + 1}. **${site.subdomain}.${site.domain}** - ${username}`;
    }).join('\n');

    const embed = new EmbedBuilder()
        .setTitle('🌐 Active Subdomains')
        .setDescription(siteList)
        .addFields(
            { name: '📊 Total Sites', value: sites.length.toString(), inline: true },
            { name: '📅 Latest', value: sites[sites.length - 1]?.created.toLocaleDateString() || 'None', inline: true }
        )
        .setColor('#667eea')
        .setFooter({ text: 'Use /createsite to create your own subdomain' });

    await interaction.editReply({ embeds: [embed] });
}

async function handleKickSlash(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.KickMembers)) {
        return interaction.reply({ content: '❌ You don\'t have permission to kick members.', ephemeral: true });
    }

    const target = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    if (!target) {
        return interaction.reply({ content: '❌ User not found.', ephemeral: true });
    }

    try {
        await target.kick(reason);
        const embed = new EmbedBuilder()
            .setTitle('👢 Member Kicked')
            .setDescription(`${target} has been kicked from the server`)
            .addFields(
                { name: 'Reason', value: reason, inline: false },
                { name: 'Moderator', value: interaction.user.toString(), inline: true }
            )
            .setColor('#FFA500');
        
        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        await interaction.reply({ content: '❌ I don\'t have permission to kick this member.', ephemeral: true });
    }
}

async function handleBanSlash(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.BanMembers)) {
        return interaction.reply({ content: '❌ You don\'t have permission to ban members.', ephemeral: true });
    }

    const target = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    if (!target) {
        return interaction.reply({ content: '❌ User not found.', ephemeral: true });
    }

    try {
        await target.ban({ reason });
        const embed = new EmbedBuilder()
            .setTitle('🔨 Member Banned')
            .setDescription(`${target} has been banned from the server`)
            .addFields(
                { name: 'Reason', value: reason, inline: false },
                { name: 'Moderator', value: interaction.user.toString(), inline: true }
            )
            .setColor('#FF0000');
        
        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        await interaction.reply({ content: '❌ I don\'t have permission to ban this member.', ephemeral: true });
    }
}

async function handleTimeoutSlash(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({ content: '❌ You don\'t have permission to timeout members.', ephemeral: true });
    }

    const target = interaction.options.getMember('user');
    const duration = interaction.options.getInteger('duration') || 300;
    const reason = interaction.options.getString('reason') || 'No reason provided';

    if (!target) {
        return interaction.reply({ content: '❌ User not found.', ephemeral: true });
    }

    try {
        await target.timeout(duration * 1000, reason);
        const embed = new EmbedBuilder()
            .setTitle('🔇 Member Timed Out')
            .setDescription(`${target} has been timed out for ${duration} seconds`)
            .addFields(
                { name: 'Reason', value: reason, inline: false },
                { name: 'Moderator', value: interaction.user.toString(), inline: true }
            )
            .setColor('#FFFF00');
        
        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        await interaction.reply({ content: '❌ I don\'t have permission to timeout this member.', ephemeral: true });
    }
}

async function handleWarnSlash(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        return interaction.reply({ content: '❌ You don\'t have permission to warn members.', ephemeral: true });
    }

    const target = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    if (!target) {
        return interaction.reply({ content: '❌ User not found.', ephemeral: true });
    }
    
    const currentWarnings = userWarnings.get(target.id) || 0;
    userWarnings.set(target.id, currentWarnings + 1);
    const warnings = userWarnings.get(target.id);

    const embed = new EmbedBuilder()
        .setTitle('⚠️ Warning Issued')
        .setDescription(`${target} has been warned`)
        .addFields(
            { name: 'Reason', value: reason, inline: false },
            { name: 'Warnings', value: `${warnings}/3`, inline: true },
            { name: 'Moderator', value: interaction.user.toString(), inline: true }
        )
        .setColor('#FFA500');
    
    await interaction.editReply({ embeds: [embed] });
    
    if (warnings >= 3) {
        await timeoutUser(target, 10 * 60 * 1000);
        const timeoutEmbed = new EmbedBuilder()
            .setTitle('🔇 Auto-Timeout')
            .setDescription(`${target} has been automatically timed out for 10 minutes (3 warnings)`)
            .setColor('#FF0000');
        
        await interaction.followUp({ embeds: [timeoutEmbed] });
        userWarnings.set(target.id, 0);
    }
}

async function handleWarningsSlash(interaction) {
    const target = interaction.options.getMember('user') || interaction.member;
    const warnings = userWarnings.get(target.id) || 0;
    
    const embed = new EmbedBuilder()
        .setTitle('📊 Warning Count')
        .setDescription(`${target} has ${warnings} warnings`)
        .setColor('#0099FF');
    
    await interaction.editReply({ embeds: [embed] });
}

async function handleClearWarningsSlash(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        return interaction.reply({ content: '❌ You don\'t have permission to clear warnings.', ephemeral: true });
    }

    const target = interaction.options.getMember('user');
    if (!target) {
        return interaction.reply({ content: '❌ User not found.', ephemeral: true });
    }

    userWarnings.set(target.id, 0);
    
    const embed = new EmbedBuilder()
        .setTitle('✅ Warnings Cleared')
        .setDescription(`Cleared all warnings for ${target}`)
        .setColor('#00FF00');
    
    await interaction.editReply({ embeds: [embed] });
}

async function handlePurgeSlash(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        return interaction.reply({ content: '❌ You don\'t have permission to purge messages.', ephemeral: true });
    }

    const amount = interaction.options.getInteger('amount') || 10;
    if (amount > 100) {
        return interaction.reply({ content: '❌ Cannot delete more than 100 messages at once.', ephemeral: true });
    }

    try {
        const deleted = await interaction.channel.bulkDelete(amount);
        const embed = new EmbedBuilder()
            .setTitle('🧹 Messages Purged')
            .setDescription(`Deleted ${deleted.size} messages`)
            .setColor('#00FF00');
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
        await interaction.reply({ content: '❌ I don\'t have permission to delete messages.', ephemeral: true });
    }
}

async function handleDomainsSlash(interaction) {
    const domainList = PUBLIC_DOMAINS.map((domain, index) => {
        return `${index + 1}. **${domain}**`;
    }).join('\n');

    const embed = new EmbedBuilder()
        .setTitle('🌐 Available Public FreeDNS Domains')
        .setDescription('Choose from these public domains when creating your subdomain:')
        .addFields(
            { name: 'Available Domains', value: domainList, inline: false },
            { name: 'How to Use', value: 'Use `/createsite <yourname> <domain>` to register', inline: false }
        )
        .setColor('#667eea')
        .setFooter({ text: 'These domains are publicly available on FreeDNS' });

    await interaction.editReply({ embeds: [embed] });
}

// Get bot token from environment variable
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
    console.error('❌ DISCORD_BOT_TOKEN environment variable not found!');
    console.error('Please set your Discord bot token using the secrets manager.');
    process.exit(1);
} else {
    client.login(token);
}
