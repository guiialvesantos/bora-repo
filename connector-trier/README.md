# Conector BoraRepô ↔ Trier Sistemas

Programa que roda **dentro da farmácia** e leva os dados do SGF para o BoraRepô.

## Por que existe

A API da Trier é local: `http://localhost:4647/sgfpod1`, sem HTTPS, endereço que
só existe na rede da loja. A alternativa documentada pela Trier é abrir a porta
4647 no roteador e contratar IP fixo ou DDNS — o que expõe o ERP inteiro em
texto claro na internet e não funciona em link com CGNAT.

Este conector inverte a direção: lê em loopback e escreve para fora por HTTPS.
**Nenhuma porta aberta, nenhum IP fixo.** E o token da Trier nunca sai da loja —
ele fica no arquivo de configuração, ao lado do servidor que ele acessa.

## Instalação

**Requisito:** Node.js 20 ou superior. Nada além disso — sem `npm install`, sem
build, sem `node_modules`.

1. Copie a pasta `connector-trier` para o servidor da farmácia.
2. Copie `borarepo.config.example.json` para `borarepo.config.json` e preencha:
   - `trierBaseUrl` — troque `localhost` pelo IP do servidor SGF se o conector
     rodar em outra máquina da rede.
   - `trierToken` — o token fornecido pela Trier para esta farmácia.
   - `connectorKey` — gerada no BoraRepô, em **Integrações → Trier Sistemas →
     Adicionar loja**. Aparece uma única vez.
3. Teste antes de instalar como serviço:

   ```
   node borarepo-trier.mjs --test
   ```

   O teste bate nos dois lados (Trier local e BoraRepô) e imprime os campos que
   aquela instalação realmente devolve. É aqui que divergências entre o
   spec e a instalação real aparecem.

4. Rode um ciclo completo à mão para conferir os números na tela:

   ```
   node borarepo-trier.mjs --once
   ```

5. Instale como serviço do Windows (ex.: com [NSSM](https://nssm.cc)):

   ```
   nssm install BoraRepoTrier "C:\Program Files\nodejs\node.exe" "C:\borarepo\borarepo-trier.mjs"
   nssm set BoraRepoTrier AppDirectory C:\borarepo
   nssm start BoraRepoTrier
   ```

## O que ele sincroniza

| Ciclo | Endpoint da Trier | Vira o quê no BoraRepô |
|---|---|---|
| `produtos` | `/produto/obter-todos-v1`, depois `obter-alterados-v1` | catálogo, preço, custo médio, laboratório, princípio ativo |
| `estoque` | `/estoque/obter-todos-v1`, depois `obter-movimentados-v1` | saldo no depósito desta loja |
| `vendas` | `/venda/obter-v1` | demanda (o que o motor usa para calcular a reposição) |
| `cancelamentos` | `/venda/cancelamento/obter-v1` | devolução e estorno, como linha negativa |
| `pedidos` | `/pedido/itens/resumido/obter-v1` | o que está em trânsito |
| `compras` | `/compra/obter-v1` | baixa do trânsito quando a mercadoria chega |

Primeiro ciclo busca 12 meses de histórico; os seguintes buscam só o que mudou.
O ponto de parada é guardado no servidor — trocar o computador da loja não
dispara um backfill novo.

## Uma loja, um conector

Cada instalação do SGF é de uma loja, e o estoque que ela devolve é só dela.
Numa rede, gere **uma chave por loja**: cada conector escreve no seu próprio
depósito dentro do BoraRepô, e o motor soma os depósitos que você marcar como
disponíveis.

## Se algo der errado

O ciclo falha, o processo não. Erros aparecem no log do serviço e também na tela
de Integrações do BoraRepô, no card da loja (`última vez visto` e `último
erro`). Uma chave comprometida é revogada pela tela, sem mexer na farmácia.

## O que este programa NÃO faz

Não traduz campo nenhum. Os objetos da Trier sobem crus e a tradução acontece no
servidor. Quando um mapeamento estiver errado, o conserto é do nosso lado — não
uma atualização de programa em cada farmácia.
