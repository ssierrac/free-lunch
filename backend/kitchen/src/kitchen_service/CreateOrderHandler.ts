import { RandomRecipeDBType, RecipeError } from "./Recipe";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { logger, metrics, tracer } from "./powetools";
import { Context, SQSEvent, SQSRecord } from "aws-lambda";
import { MetricUnits } from "@aws-lambda-powertools/metrics";
import { OrderDBType, OrderError, OrderStatusEnum } from "./Order";
import type { LambdaInterface } from "@aws-lambda-powertools/commons";
import { DynamoDBClient, PutItemCommand, PutItemCommandInput, PutItemCommandOutput, ScanCommand, ScanCommandInput } from "@aws-sdk/client-dynamodb";

const ddbClient = new DynamoDBClient({})
const ORDERS_TABLE = process.env.ORDERS_TABLE
const RECIPES_TABLE = process.env.RECIPES_TABLE

class CreateOrderHandlerFunction implements LambdaInterface {

    /**
     * @public
     * @async
     * @method handler
     * @param {SQSEvent}
     * @param {Context}
     * @returns {Promise<void>}
     */
    @tracer.captureLambdaHandler()
    @metrics.logMetrics({ captureColdStartMetric: true, throwOnEmptyMetrics: true })
    @logger.injectLambdaContext({ logEvent: true })
    public async handler(event: SQSEvent, context: Context): Promise<void> {

        for (const sqsRecord of event.Records) {
            const order = this.parseOrder(sqsRecord)
            if (sqsRecord.messageAttributes.HttpMethod.stringValue === "POST") {
                logger.info("Creating an order", { order })
                try {
                    await this.createOrder(order)
                    tracer.putMetadata("OrderStatus", order)
                } catch (e) {
                    tracer.addErrorAsMetadata(e as Error)
                    logger.error("Error during DDB PUT", e as Error)
                    throw e
                }
            } else {
                tracer.addErrorAsMetadata(Error("Request not supported"))
                logger.error("Error request not supported")
            }
        }
    }

    /**
     * Creates a new order in the database
     * 
     * @private
     * @async
     * @method createOrder
     * @param {OrderDBType} order - the order to create
     * @returns {Promise<void>}
     * @throws {OrderError}
     */
    @tracer.captureMethod()
    private async createOrder(order: OrderDBType): Promise<void> {
        tracer.putAnnotation("order_id", order.order_id)
        logger.info("Constructing DB Entry for order", { order })
        const createDate = new Date()
        const recipe: RandomRecipeDBType = await this.getRandomRecipe()
        const dbEntry: OrderDBType = {
            order_id: order.order_id,
            order_created: createDate.toISOString(),
            order_last_modified_on: createDate.toISOString(),
            order_status: OrderStatusEnum.ACCEPTED,
            recipe_id: recipe.recipe_id
        }
        logger.info("Record to insert", { dbEntry })

        const ddbPutCommandInput: PutItemCommandInput = {
            TableName: ORDERS_TABLE,
            Item: marshall(dbEntry, { removeUndefinedValues: true }),
            ConditionExpression: 'attribute_not_exists(order_id) OR attribute_exists(order_status) AND contract_status IN (:CANCELLED)',
            ExpressionAttributeValues: {
                ':CANCELLED': { S: OrderStatusEnum.CANCELLED }
            }
        }

        try {
            const ddbPutCommand = new PutItemCommand(ddbPutCommandInput);
            const ddbPutCommandOutput: PutItemCommandOutput = await ddbClient.send(ddbPutCommand)
            if (ddbPutCommandOutput.$metadata.httpStatusCode != 200) {
                let error: OrderError = {
                    orderId: dbEntry.order_id,
                    name: "OrderDBSaveError",
                    message: `Response error code: ${ddbPutCommandOutput.$metadata.httpStatusCode}`,
                    object: ddbPutCommandOutput.$metadata
                }
                throw error
            }

            logger.info("Inserted record for order", {
                orderId: dbEntry.order_id,
                metadata: ddbPutCommandOutput.$metadata
            })
            metrics.addMetric("OrderCreated", MetricUnits.Count, 1)
        } catch (e) {
            let error: OrderError = {
                orderId: dbEntry.order_id,
                name: "OrderDBSaveError",
                message: `Response error`,
                object: e
            }
            throw error
        }


    }


    private async getRandomRecipe(): Promise<RandomRecipeDBType> {
        try {
            const ScanCommandInput: ScanCommandInput = {
                TableName: RECIPES_TABLE,
                ProjectionExpression: 'recipe_id',
                ReturnConsumedCapacity: 'TOTAL',
            };
            const data = await ddbClient.send(new ScanCommand(ScanCommandInput));
            if (data.Items) {
                const items = data.Items.filter((i) => i?.recipe_id);
                const randomRecipe = items[Math.floor(Math.random() * items.length)]
                return unmarshall(randomRecipe) as RandomRecipeDBType
            } else {
                let error: RecipeError = {
                    recipe_id: "N/A",
                    name: "RecipeDBScanError",
                    message: "Cant get a random recipe",
                    object: data.$metadata
                }
                throw error
            }
        } catch (e) {
            let error: RecipeError = {
                recipe_id: "N/A",
                name: "RecipeDBScanError",
                message: "Cant get a random recipe",
                object: e
            }
            throw error
        }
    }

    private parseOrder(record: SQSRecord): OrderDBType {
        let order: OrderDBType
        try {
            order = JSON.parse(record.body);
        } catch (e) {
            const msg = "Error parsing SQS Record"
            tracer.addErrorAsMetadata(e as Error)
            logger.error(msg, e as Error)
            throw (new Error(msg))
        }
        logger.info("Returning order", { order })
        return order
    }

}

export const CreateOrderHandler = new CreateOrderHandlerFunction()
export const lambdaHandler = CreateOrderHandler.handler.bind(CreateOrderHandler)
