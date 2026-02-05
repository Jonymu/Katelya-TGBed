export async function onRequest(context) {
    const { env, params } = context;
    const fileId = params.id;
    console.log('Deleting file:', fileId);
    
    try {
      // 优先读取 KV 元数据，判断存储类型与 Telegram 信息
      let record = null;
      let actualKVKey = null; // 🔥 记录实际找到的完整Key（包含前缀）
      
      if (env.img_url) {
        const prefixes = ['img:', 'vid:', 'aud:', 'doc:', 'r2:', ''];
        for (const prefix of prefixes) {
          const key = `${prefix}${fileId}`;
          record = await env.img_url.getWithMetadata(key);
          if (record && record.metadata) {
            actualKVKey = key; // 🔥 保存找到的实际Key
            console.log('Found KV record with key:', actualKVKey);
            break;
          }
        }
      }

      if (!record || !record.metadata) {
        throw new Error('文件元数据不存在，无法删除');
      }

      const metadata = record.metadata;
      const isR2 = fileId.startsWith('r2:') || metadata.storageType === 'r2' || metadata.storage === 'r2';

      // R2 文件：先删对象，再删 KV
      if (isR2) {
        const r2Key = metadata.r2Key || fileId.replace('r2:', '');
        console.log('Deleting R2 object:', r2Key);
        
        if (!env.R2_BUCKET) {
          throw new Error('R2 未配置，无法删除对象');
        }
        
        // 🔥 先删除R2对象，等待确认
        await env.R2_BUCKET.delete(r2Key);
        console.log('R2 object deleted successfully');
        
        // 🔥 然后删除KV元数据（使用正确的Key）
        if (env.img_url && actualKVKey) {
          await env.img_url.delete(actualKVKey);
          console.log('KV metadata deleted:', actualKVKey);
        }

        return new Response(JSON.stringify({ 
          success: true, 
          message: '已从 R2 与 KV 彻底删除',
          fileId,
          r2Key,
          kvKey: actualKVKey
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Telegram 文件：尝试删除消息（需要 metadata.telegramMessageId）
      let telegramDeleted = false;
      
      if (metadata.telegramMessageId) {
        console.log('Attempting to delete Telegram message:', metadata.telegramMessageId);
        telegramDeleted = await deleteTelegramMessage(metadata.telegramMessageId, env);
        
        if (telegramDeleted) {
          console.log('Telegram message deleted successfully');
        } else {
          console.error('Telegram message deletion failed');
        }
      } else {
        console.warn('No telegramMessageId found in metadata');
      }

      // 🔥 严格模式：如果有messageId但删除失败，则报错阻止伪删除
      if (metadata.telegramMessageId && !telegramDeleted) {
        throw new Error('Telegram 消息删除失败，已阻止伪删除操作');
      }

      // 🔥 如果没有messageId，仍然删除KV元数据（让文件无法访问）
      // 但会在响应中标注警告
      if (env.img_url && actualKVKey) {
        await env.img_url.delete(actualKVKey);
        console.log('KV metadata deleted:', actualKVKey);
      }

      const warningMessage = !metadata.telegramMessageId 
        ? '警告：无 messageId，仅删除元数据，Telegram 原文件可能仍存在' 
        : '';

      return new Response(JSON.stringify({ 
        success: true, 
        message: telegramDeleted 
          ? '已从 Telegram 与 KV 彻底删除' 
          : '已删除 KV 元数据，文件已无法访问',
        fileId,
        kvKey: actualKVKey,
        telegramDeleted,
        warning: warningMessage
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error) {
      console.error('Delete error:', error);
      return new Response(JSON.stringify({ 
        success: false, 
        error: error.message 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

async function deleteTelegramMessage(messageId, env) {
  if (!env.TG_Bot_Token || !env.TG_Chat_ID) return false;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${env.TG_Bot_Token}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TG_Chat_ID,
        message_id: messageId
      })
    });
    const data = await resp.json();
    return resp.ok && data.ok;
  } catch (error) {
    console.error('Telegram delete message error:', error);
    return false;
  }
}