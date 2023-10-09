import { randomUUID } from "crypto";
import { RecipeDBType, RecipeError } from "./Recipe";
import { marshall } from "@aws-sdk/util-dynamodb";
import { logger, metrics, tracer } from "./powetools";
import { Context, APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { MetricUnits } from "@aws-lambda-powertools/metrics";
import type { LambdaInterface } from "@aws-lambda-powertools/commons";
import { DynamoDBClient, PutItemCommand, PutItemCommandInput, PutItemCommandOutput } from "@aws-sdk/client-dynamodb";

const ddbClient = new DynamoDBClient({})
const RECIPES_TABLE = process.env.RECIPES_TABLE

const ingredients = ["tomato", "lemon", "potato", "rice", "ketchup", "lettuce", "onion", "cheese", "meat", "chicken"]

class CreateRecipeHandlerFunction implements LambdaInterface {

    /**
     * @public
     * @async
     * @method handler
     * @param {APIGatewayProxyEvent}
     * @param {Context}
     * @returns {Promise<APIGatewayProxyResult>}
     */
    @tracer.captureLambdaHandler()
    @metrics.logMetrics({ captureColdStartMetric: true })
    @logger.injectLambdaContext({ logEvent: true })
    public async handler(event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> {
        logger.info(`Handling request for ${event.resource}`)
        if (event.httpMethod === "POST") {
            let recipe: RecipeDBType = this.parseRecipe(event.body!)
            try {
                const newRecipe = await this.createRecipe(recipe)
                return {
                    statusCode: 200,
                    body: JSON.stringify(newRecipe),
                };
            } catch (e) {
                tracer.addErrorAsMetadata(e as Error)
                logger.error("Error during DDB PUT", e as Error)
                return {
                    statusCode: 400,
                    body: JSON.stringify({
                        message: `Unable to handle resource ${event.resource}`,
                    }),
                };
            }
        } else {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    message: `Unable to handle resource ${event.resource}`,
                }),
            };
        }
    }

    /**
     * Creates a new order in the database
     * 
     * @private
     * @async
     * @method createRecipe
     * @param {RecipeDBType} recipe - the recipe to create
     * @returns {Promise<RecipeDBType>}
     * @throws {OrderError}
     */
    @tracer.captureMethod()
    private async createRecipe(recipe: RecipeDBType): Promise<RecipeDBType> {
        tracer.putAnnotation("order_id", recipe.name)
        logger.info("Constructing DB Entry for recipe", { recipe })
        const createDate = new Date()
        const recipe_id = randomUUID()
        const dbEntry: RecipeDBType = {
            recipe_id,
            name: recipe.name,
            recipe_created: createDate.toISOString(),
            recipe_last_modified_on: createDate.toISOString(),
            ingredients: recipe.ingredients
        }

        logger.info("Record to insert", { dbEntry })
        const ddbPutCommandInput: PutItemCommandInput = {
            TableName: RECIPES_TABLE,
            Item: marshall(dbEntry, { removeUndefinedValues: true }),
            ConditionExpression: 'attribute_not_exists(property_id)',
            ReturnValues: "ALL_OLD"
        }

        try {
            const ddbPutCommand = new PutItemCommand(ddbPutCommandInput)
            const ddbPutCommandOutput: PutItemCommandOutput = await ddbClient.send(ddbPutCommand)
            if (ddbPutCommandOutput.$metadata.httpStatusCode != 200) {
                let error: RecipeError = {
                    recipe_id: dbEntry.recipe_id!,
                    name: "OrderDBSaveError",
                    message: `Response error code: ${ddbPutCommandOutput.$metadata.httpStatusCode}`,
                    object: ddbPutCommandOutput.$metadata
                }
                throw error
            }

            logger.info("Inserted record for recipe", {
                recipe_id: dbEntry.recipe_id,
                return_values: ddbPutCommandOutput.Attributes
            })
            return dbEntry

        } catch (e) {
            let error: RecipeError = {
                recipe_id: dbEntry.recipe_id!,
                name: "OrderDBSaveError",
                message: `OrderDBSaveError`,
                object: e
            }
            throw error
        }
    }

    private parseRecipe(body: string): RecipeDBType {
        let recipe: RecipeDBType
        try {
            recipe = JSON.parse(body);
        } catch (e) {
            const msg = "Error parsing body"
            tracer.addErrorAsMetadata(e as Error)
            logger.error(msg, e as Error)
            throw (new Error(msg))
        }
        logger.info("Returning recipe", { recipe })
        return recipe
    }

}

export const CreateRecipeHandler = new CreateRecipeHandlerFunction()
export const lambdaHandler = CreateRecipeHandler.handler.bind(CreateRecipeHandler)
