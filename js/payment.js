const ATIVO_PAY_API = 'https://api.conta.ativopay.com/v1';
const SECRET_KEY = 'sk_live_JdXumNvm82oC8AUOO6p7ftt5AK8JDL8vEzSBEgEbOb';
const TRACKING_WEBHOOK = 'https://n8n.caesarapp.site/webhook/vivapl';

const PaymentService = {
    authorization: 'Basic ' + btoa(SECRET_KEY + ':x'),

    createTrackingData(data) {
        if (!data.orderId) {
            throw new Error('orderId é obrigatório');
        }

        // Recupera os parâmetros UTM do localStorage
        const storedUtmParams = JSON.parse(localStorage.getItem('utmParams') || '{}');
        
        const trackingData = [{
            headers: {
                'host': 'n8n.caesarapp.site',
                'content-type': 'application/json',
                'x-api-token': 'gr9kkW2d7JrCesqFCLXHPCjyavcQhIyosIY9'
            },
            params: {},
            query: {},
            body: {
                orderId: data.orderId,
                platform: 'Viva Sorte',
                paymentMethod: 'pix',
                status: data.status || 'waiting_payment',
                createdAt: data.createdAt || new Date().toISOString(),
                approvedDate: data.status === 'paid' ? data.approvedDate : null,
                valor: parseFloat((data.amount / 100).toFixed(2)),
                valorTotal: parseFloat((data.amount / 100).toFixed(2)),
                customer: {
                    name: data.customer?.name || 'Viva Sorte',
                    email: data.customer?.email || '',
                    phone: data.customer?.phone || '',
                    document: {
                        type: 'cpf',
                        number: data.customer?.document || ''
                    }
                },
                trackingParameters: {
                    src: storedUtmParams.src || null,
                    sck: storedUtmParams.sck || null,
                    utm_source: storedUtmParams.utm_source || null,
                    utm_campaign: storedUtmParams.utm_campaign || null,
                    utm_medium: storedUtmParams.utm_medium || null,
                    utm_content: storedUtmParams.utm_content || null,
                    utm_term: storedUtmParams.utm_term || null
                },
                products: [
                    {
                        id: 'main-raffle',
                        name: 'Viva Sorte - ' + new Date().toLocaleDateString(),
                        quantity: parseInt(data.product?.quantity) || 1,
                        priceInCents: parseInt(data.product?.priceInCents) || 199
                    }
                ]
            },
            webhookUrl: TRACKING_WEBHOOK,
            executionMode: 'production'
        }];

        console.log('Dados de tracking gerados:', JSON.stringify(trackingData, null, 2));
        return trackingData;
    },

    async createPixTransaction(data) {
        try {
            console.log('Criando transação PIX com dados:', JSON.stringify(data, null, 2));
            
            const response = await fetch(`${ATIVO_PAY_API}/transactions`, {
                method: 'POST',
                headers: {
                    'Authorization': this.authorization,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    amount: data.amount,
                    paymentMethod: 'pix',
                    customer: {
                        name: data.customerName,
                        email: data.customerEmail,
                        document: {
                            type: 'cpf',
                            number: data.customerDocument
                        },
                        phone: data.customerPhone
                    },
                    items: [
                        {
                            title: 'Cotas Viva Sorte',
                            quantity: data.quantity,
                            unitPrice: 199,
                            tangible: false
                        }
                    ],
                    pix: {
                        expiresIn: 900
                    },
                    postbackUrl: window.location.origin + '/payment-webhook',
                    metadata: `Compra de ${data.quantity} cotas`
                })
            });

            const responseData = await response.json();
            console.log('Resposta da criação do PIX:', JSON.stringify(responseData, null, 2));

            if (!response.ok) {
                throw new Error(responseData.message || 'Erro ao criar transação PIX');
            }

            // Envia dados para tracking inicial
            const now = new Date().toISOString();
            const trackingData = {
                orderId: responseData.id,
                status: 'waiting_payment',
                createdAt: now,
                approvedDate: null,
                customer: {
                    name: data.customerName,
                    email: data.customerEmail,
                    phone: data.customerPhone,
                    document: data.customerDocument
                },
                product: {
                    quantity: parseInt(data.quantity),
                    priceInCents: parseInt(data.amount)
                },
                amount: parseInt(data.amount)
            };

            console.log('Enviando tracking inicial:', JSON.stringify(trackingData, null, 2));
            await this.sendTracking(trackingData);

            // Inicia o polling para verificar o status
            this.startPaymentStatusPolling(responseData.id, trackingData);

            return {
                id: responseData.id,
                pix: {
                    copy_paste: responseData.pix.qrcode || responseData.pix.code || responseData.pix.text,
                    qrcode: responseData.pix.qrcode_image || responseData.pix.image || responseData.pix.base64
                }
            };
        } catch (error) {
            console.error('Erro na transação:', error);
            throw error;
        }
    },

    startPaymentStatusPolling(transactionId, initialData) {
        let pollCount = 0;
        const maxPolls = 180; // 15 minutos (180 * 5 segundos)
        
        console.log(`Iniciando verificação de status para transação ${transactionId}`);
        
        const pollInterval = setInterval(async () => {
            try {
                pollCount++;
                console.log(`Verificação #${pollCount} para transação ${transactionId}`);
                
                const status = await this.checkTransactionStatus(transactionId);
                console.log(`Status atual da transação ${transactionId}: ${status}`);
                
                if (status === 'paid') {
                    console.log(`Pagamento confirmado para transação ${transactionId}!`);
                    clearInterval(pollInterval);
                    
                    try {
                        // Envia atualização para o webhook
                        const now = new Date().toISOString();
                        const updatedData = {
                            ...initialData,
                            status: 'paid',
                            approvedDate: now
                        };
                        
                        console.log('Enviando atualização de status para paid:', JSON.stringify(updatedData, null, 2));
                        await this.sendTracking(updatedData);
                        console.log('Webhook enviado com sucesso');
                        
                        // Só redireciona após o webhook ser enviado com sucesso
                        window.location.href = '/pagamento-confirmado.html';
                    } catch (webhookError) {
                        console.error('Erro ao enviar webhook:', webhookError);
                        // Mesmo com erro no webhook, redireciona o usuário
                        window.location.href = '/pagamento-confirmado.html';
                    }
                } else if (pollCount >= maxPolls) {
                    console.log(`Tempo máximo de verificação atingido para transação ${transactionId}`);
                    clearInterval(pollInterval);
                }
            } catch (error) {
                console.error(`Erro ao verificar status da transação ${transactionId}:`, error);
                clearInterval(pollInterval);
            }
        }, 5000);
    },

    async checkTransactionStatus(transactionId) {
        try {
            console.log(`Verificando status da transação ${transactionId}`);
            
            const response = await fetch(`${ATIVO_PAY_API}/transactions/${transactionId}`, {
                headers: {
                    'Authorization': this.authorization
                }
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || 'Erro ao verificar status da transação');
            }

            const result = await response.json();
            console.log(`Resposta da verificação de status para ${transactionId}:`, JSON.stringify(result, null, 2));
            
            return result.status;
        } catch (error) {
            console.error('Erro ao verificar status:', error);
            throw error;
        }
    },

    async sendTracking(data) {
        try {
            const trackingData = this.createTrackingData(data);
            console.log('Enviando requisição de tracking:', {
                url: TRACKING_WEBHOOK,
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Token': 'gr9kkW2d7JrCesqFCLXHPCjyavcQhIyosIY9'
                },
                body: trackingData
            });

            const response = await fetch(TRACKING_WEBHOOK, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Token': 'gr9kkW2d7JrCesqFCLXHPCjyavcQhIyosIY9'
                },
                body: JSON.stringify(trackingData)
            });

            const responseData = await response.json();
            console.log('Resposta do tracking:', JSON.stringify(responseData, null, 2));

            if (!response.ok) {
                console.error('Erro detalhado tracking:', responseData);
                throw new Error('Erro ao enviar dados de tracking');
            }

            return responseData;
        } catch (error) {
            console.error('Erro ao enviar tracking:', error);
            throw error;
        }
    }
};

// Expõe o serviço globalmente
window.PaymentService = PaymentService; 