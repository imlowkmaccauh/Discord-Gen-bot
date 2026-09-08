const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
  AttachmentBuilder, ChannelType
} = require("discord.js");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  throw new Error("Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID.");
}

const db = new Database(path.join(process.cwd(), "bot.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS stock (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('free','premium')),
  value TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id TEXT PRIMARY KEY,
  expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS cooldowns (
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, type)
);
CREATE TABLE IF NOT EXISTS config (
  guild_id TEXT PRIMARY KEY,
  free_channel_id TEXT,
  premium_channel_id TEXT,
  prices_channel_id TEXT,
  logs_channel_id TEXT
);
`);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});

const ownerRole = process.env.OWNER_ROLE_ID;
const adminRole = process.env.ADMIN_ROLE_ID;
const premiumRole = process.env.PREMIUM_ROLE_ID;
const freeCooldown = Number(process.env.FREE_COOLDOWN_SECONDS || 3600);
const premiumCooldown = Number(process.env.PREMIUM_COOLDOWN_SECONDS || 3600);

function hasRole(interaction, roleId) {
  return roleId && interaction.member?.roles?.cache?.has(roleId);
}
function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || hasRole(interaction, adminRole);
}
function isOwner(interaction) {
  return hasRole(interaction, ownerRole) || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}
function getConfig(guildId) {
  return db.prepare("SELECT * FROM config WHERE guild_id=?").get(guildId) || {};
}
function upsertConfig(guildId, field, value) {
  const existing = getConfig(guildId);
  if (!existing.guild_id) {
    db.prepare("INSERT INTO config (guild_id) VALUES (?)").run(guildId);
  }
  db.prepare(`UPDATE config SET ${field}=? WHERE guild_id=?`).run(value, guildId);
}
function premiumActive(userId) {
  const row = db.prepare("SELECT expires_at FROM subscriptions WHERE user_id=?").get(userId);
  if (!row) return false;
  if (row.expires_at === null) return true;
  if (Date.now() < row.expires_at) return true;
  db.prepare("DELETE FROM subscriptions WHERE user_id=?").run(userId);
  return false;
}
function fmtDuration(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}
async function sendLog(guild, title, description, priority=false) {
  const cfg = getConfig(guild.id);
  if (!cfg.logs_channel_id) return;
  const channel = await guild.channels.fetch(cfg.logs_channel_id).catch(() => null);
  if (!channel?.isTextBased()) return;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setTimestamp()
    .setColor(priority ? 0xFF0000 : 0x808080);
  await channel.send({ embeds: [embed] }).catch(() => {});
}
async function postPrices(guild) {
  const cfg = getConfig(guild.id);
  if (!cfg.prices_channel_id) return;
  const channel = await guild.channels.fetch(cfg.prices_channel_id).catch(() => null);
  if (!channel?.isTextBased()) return;
  const embed = new EmbedBuilder()
    .setTitle("Gen Prices")
    .setDescription(
      "🕐 **1 Day** — £3 GBP\n" +
      "📅 **3 Days** — £5 GBP\n" +
      "📅 **7 Days** — £10 GBP\n" +
      "📅 **30 Days** — £25 GBP\n" +
      "♾️ **Lifetime** — £40 GBP"
    );
  const recent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
  const old = recent?.find(m => m.author.id === client.user.id && m.embeds[0]?.title === "Gen Prices");
  if (old) await old.edit({ embeds: [embed] }).catch(() => {});
  else await channel.send({ embeds: [embed] }).catch(() => {});
}

const commands = [
  new SlashCommandBuilder().setName("generatefree").setDescription("Generate a Free account"),
  new SlashCommandBuilder().setName("generatepremium").setDescription("Generate a Premium account"),
  new SlashCommandBuilder().setName("remove_stock").setDescription("Remove one stock item")
    .addStringOption(o => o.setName("type").setDescription("Stock type").setRequired(true)
      .addChoices({name:"Free Gen",value:"free"},{name:"Premium Gen",value:"premium"})),
  new SlashCommandBuilder().setName("add_premsub").setDescription("Give a user Premium")
    .addUserOption(o=>o.setName("user").setDescription("User").setRequired(true))
    .addStringOption(o=>o.setName("duration").setDescription("Premium duration").setRequired(true)
      .addChoices(
        {name:"1 Day",value:"1d"},{name:"3 Days",value:"3d"},{name:"7 Days",value:"7d"},
        {name:"1 Month",value:"30d"},{name:"Lifetime",value:"life"})),
  new SlashCommandBuilder().setName("removesub").setDescription("Remove a user's Premium")
    .addUserOption(o=>o.setName("user").setDescription("User").setRequired(true)),
  new SlashCommandBuilder().setName("addstock").setDescription("Add stock from a .txt file")
    .addStringOption(o=>o.setName("type").setDescription("Stock type").setRequired(true)
      .addChoices({name:"Free Gen",value:"free"},{name:"Premium Gen",value:"premium"}))
    .addAttachmentOption(o=>o.setName("file").setDescription("TXT stock file").setRequired(true)),
  new SlashCommandBuilder().setName("show_stock").setDescription("DM all current stock as TXT files"),
  new SlashCommandBuilder().setName("generator_configure").setDescription("Configure generator channels")
    .addChannelOption(o=>o.setName("free_channel").setDescription("Free Gen channel").addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o=>o.setName("premium_channel").setDescription("Premium Gen channel").addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o=>o.setName("prices_channel").setDescription("Gen Prices channel").addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o=>o.setName("logs_channel").setDescription("Gen Logs channel").addChannelTypes(ChannelType.GuildText))
].map(c=>c.toJSON());

async function registerCommands() {
  const rest = new REST({version:"10"}).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {body:commands});
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;
  const guild = interaction.guild;
  if (!guild) return interaction.reply({content:"❌ This command can only be used in a server.",ephemeral:true});

  try {
    if (name === "generatefree" || name === "generatepremium") {
      const type = name === "generatefree" ? "free" : "premium";
      const cfg = getConfig(guild.id);
      const allowed = type === "free" ? cfg.free_channel_id : cfg.premium_channel_id;
      if (allowed && interaction.channelId !== allowed)
        return interaction.reply({content:`❌ Use this command in <#${allowed}>.`,ephemeral:true});

      if (type === "premium" && !premiumActive(interaction.user.id) && !hasRole(interaction, premiumRole))
        return interaction.reply({content:"❌ You need an active Premium subscription.",ephemeral:true});

      const cd = db.prepare("SELECT expires_at FROM cooldowns WHERE user_id=? AND type=?").get(interaction.user.id,type);
      if (cd && Date.now() < cd.expires_at)
        return interaction.reply({content:`⏳ You are on cooldown for **${fmtDuration(cd.expires_at-Date.now())}**.`,ephemeral:true});

      const item = db.prepare("SELECT id,value FROM stock WHERE type=? ORDER BY id LIMIT 1").get(type);
      if (!item) {
        await sendLog(guild, `${type === "free" ? "Free" : "Premium"} stock out of stock`,
          `${interaction.user} attempted to generate, but ${type} stock is empty.`, true);
        return interaction.reply({content:`❌ ${type === "free" ? "Free" : "Premium"} stock is empty.`,ephemeral:true});
      }

      const tx = db.transaction(() => {
        db.prepare("DELETE FROM stock WHERE id=?").run(item.id);
        db.prepare("INSERT OR REPLACE INTO cooldowns (user_id,type,expires_at) VALUES (?,?,?)")
          .run(interaction.user.id,type,Date.now() + (type==="free"?freeCooldown:premiumCooldown)*1000);
      });
      tx();

      try {
        await interaction.user.send({
          content:`🎁 **${type === "free" ? "Free" : "Premium"} Account**\n\`\`\`\n${item.value}\n\`\`\``
        });
      } catch {
        db.prepare("INSERT OR IGNORE INTO stock (type,value) VALUES (?,?)").run(type,item.value);
        db.prepare("DELETE FROM cooldowns WHERE user_id=? AND type=?").run(interaction.user.id,type);
        return interaction.reply({content:"❌ I couldn't DM you. Enable DMs and try again.",ephemeral:true});
      }

      await sendLog(guild, `${type === "free" ? "Free" : "Premium"} Gen`,
        `${interaction.user} generated one ${type} account.`, false);
      return interaction.reply({content:"✅ Account sent to your DMs.",ephemeral:true});
    }

    if (name === "remove_stock") {
      if (!isAdmin(interaction)) return interaction.reply({content:"❌ Admins only.",ephemeral:true});
      const type = interaction.options.getString("type");
      const item = db.prepare("SELECT id,value FROM stock WHERE type=? ORDER BY id LIMIT 1").get(type);
      if (!item) return interaction.reply({content:"❌ That stock is empty.",ephemeral:true});
      db.prepare("DELETE FROM stock WHERE id=?").run(item.id);
      await sendLog(guild,"Stock Removed",`${interaction.user} removed one ${type} stock item.`,false);
      return interaction.reply({content:`🗑️ Removed 1 ${type} stock item.`,ephemeral:true});
    }

    if (name === "add_premsub") {
      if (!isOwner(interaction)) return interaction.reply({content:"❌ Owner role only.",ephemeral:true});
      const user = interaction.options.getUser("user");
      const duration = interaction.options.getString("duration");
      const ms = ({1:86400000,3:259200000,7:604800000,30:2592000000})[duration?.replace("d","")];
      const expires = duration === "life" ? null : Date.now()+ms;
      db.prepare("INSERT OR REPLACE INTO subscriptions(user_id,expires_at) VALUES (?,?)").run(user.id,expires);
      const member = await guild.members.fetch(user.id).catch(()=>null);
      if (premiumRole && member) await member.roles.add(premiumRole).catch(()=>{});
      await sendLog(guild,"Premium Subscription Added",`${interaction.user} gave ${user} ${duration==="life"?"Lifetime":duration} Premium.`,false);
      return interaction.reply({content:`✅ Premium added to ${user}.`,ephemeral:true});
    }

    if (name === "removesub") {
      if (!isOwner(interaction)) return interaction.reply({content:"❌ Owner role only.",ephemeral:true});
      const user = interaction.options.getUser("user");
      db.prepare("DELETE FROM subscriptions WHERE user_id=?").run(user.id);
      const member = await guild.members.fetch(user.id).catch(()=>null);
      if (premiumRole && member) await member.roles.remove(premiumRole).catch(()=>{});
      await sendLog(guild,"Premium Subscription Removed",`${interaction.user} removed Premium from ${user}.`,false);
      return interaction.reply({content:`✅ Premium removed from ${user}.`,ephemeral:true});
    }

    if (name === "addstock") {
      if (!isAdmin(interaction)) return interaction.reply({content:"❌ Admins only.",ephemeral:true});
      const type = interaction.options.getString("type");
      const file = interaction.options.getAttachment("file");
      if (!file.name.toLowerCase().endsWith(".txt"))
        return interaction.reply({content:"❌ Only `.txt` files are accepted.",ephemeral:true});
      await interaction.deferReply({ephemeral:true});
      const res = await fetch(file.url);
      if (!res.ok) return interaction.editReply("❌ Couldn't download the file.");
      const text = await res.text();
      const lines = [...new Set(text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean))];
      const stmt = db.prepare("INSERT OR IGNORE INTO stock(type,value) VALUES (?,?)");
      let added=0;
      const tx=db.transaction(()=>{for(const line of lines){const r=stmt.run(type,line);added+=r.changes;}});
      tx();
      await sendLog(guild,"Stock Added",`${interaction.user} added ${added} ${type} stock items.`,false);
      return interaction.editReply(`✅ Added **${added}** ${type} stock items.`);
    }

    if (name === "show_stock") {
      if (!isAdmin(interaction)) return interaction.reply({content:"❌ Admins only.",ephemeral:true});
      await interaction.deferReply({ephemeral:true});
      const free=db.prepare("SELECT value FROM stock WHERE type='free' ORDER BY id").all().map(x=>x.value);
      const prem=db.prepare("SELECT value FROM stock WHERE type='premium' ORDER BY id").all().map(x=>x.value);
      const dir=path.join(process.cwd(),"tmp");
      fs.mkdirSync(dir,{recursive:true});
      const freePath=path.join(dir,"free_stock.txt"), premPath=path.join(dir,"premium_stock.txt");
      fs.writeFileSync(freePath,free.join("\n"));
      fs.writeFileSync(premPath,prem.join("\n"));
      try {
        await interaction.user.send({content:"📦 Current stock:",files:[
          new AttachmentBuilder(freePath),new AttachmentBuilder(premPath)
        ]});
      } catch {
        return interaction.editReply("❌ I couldn't DM you. Enable DMs and try again.");
      }
      await sendLog(guild,"Stock Exported",`${interaction.user} ran /Show_Stock.`,true);
      return interaction.editReply("✅ Stock files sent to your DMs.");
    }

    if (name === "generator_configure") {
      if (!isAdmin(interaction)) return interaction.reply({content:"❌ Admins only.",ephemeral:true});
      const fields = [
        ["free_channel","free_channel_id"],["premium_channel","premium_channel_id"],
        ["prices_channel","prices_channel_id"],["logs_channel","logs_channel_id"]
      ];
      let changed=[];
      for (const [opt,field] of fields) {
        const ch=interaction.options.getChannel(opt);
        if(ch){upsertConfig(guild.id,field,ch.id);changed.push(`${opt}: ${ch}`);}
      }
      if (!changed.length) return interaction.reply({content:"❌ Select at least one channel.",ephemeral:true});
      await postPrices(guild);
      return interaction.reply({content:`✅ Configuration updated.\n${changed.join("\n")}`,ephemeral:true});
    }
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) interaction.editReply("❌ An unexpected error occurred.");
    else interaction.reply({content:"❌ An unexpected error occurred.",ephemeral:true});
  }
});

client.login(token);
