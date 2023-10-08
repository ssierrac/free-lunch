import axios, { AxiosError } from 'axios';
import jwkToPem from 'jwk-to-pem';
import jwt from 'jsonwebtoken';
import { APIGatewayTokenAuthorizerEvent, AuthResponse, PolicyDocument } from 'aws-lambda';

let is_cold_start = true;
const pems: { [key: string]: string } = {};
const user_pool_id = process.env.USER_POOL_ID;
const app_client_id = process.env.APP_CLIENT_ID;
const admin_group_name = process.env.ADMIN_GROUP_NAME;

const HttpVerb = {
    GET: 'GET',
    POST: 'POST',
    PUT: 'PUT',
    PATCH: 'PATCH',
    DELETE: 'DELETE',
    HEAD: 'HEAD',
    OPTIONS: 'OPTIONS',
    ALL: '*',
};

class AuthPolicy {
    public awsAccountId: string;
    public principalId: string;
    private readonly pathRegex = '^[/.a-zA-Z0-9-*]+$';
    private allowMethods: any[];
    private denyMethods: any[];
    public restApiId: string;
    public region: string;
    public stage: string;
    private readonly version = '2012-10-17';

    constructor(principalId: string, awsAccountId: string, restApiId: string, region: string, stage: string) {
        this.principalId = principalId;
        this.awsAccountId = awsAccountId;
        this.restApiId = restApiId;
        this.region = region;
        this.stage = stage;
        this.allowMethods = [];
        this.denyMethods = [];
    }

    private addMethod(effect: string, verb: string, resource: string, conditions?: any): void {
        if (verb !== '*' && !Object.keys(HttpVerb).includes(verb)) {
            throw new Error(`Invalid HTTP verb ${verb}`);
        }
        if (resource.length > 0 && !resource.match(this.pathRegex)) {
            throw new Error(`Invalid resource path: ${resource}`);
        }
        if (resource[0] === '/') {
            resource = resource.substring(1);
        }

        const resource_arn = `arn:aws:execute-api:${this.region}:${this.awsAccountId}:${this.restApiId}/${this.stage}/${verb}/${resource}`;

        if (effect.toLowerCase() === 'allow') {
            this.allowMethods.push({
                resource_arn,
                conditions,
            });
        } else if (effect.toLowerCase() === 'deny') {
            this.denyMethods.push({
                resource_arn,
                conditions,
            });
        }
    }

    private get_empty_statement(effect: string): any {
        const statement = {
            Action: 'execute-api:Invoke',
            Effect: effect.charAt(0).toUpperCase() + effect.slice(1).toLowerCase(),
            Resource: [],
        };
        return statement;
    }

    private get_statement_for_effect(effect: string, methods: any[]): any[] {
        const statements = [];
        if (methods.length > 0) {
            const statement = this.get_empty_statement(effect);
            methods.forEach((curMethod) => {
                if (!curMethod.conditions || curMethod.conditions.length === 0) {
                    statement.Resource.push(curMethod.resource_arn);
                } else {
                    const conditionalStatement = this.get_empty_statement(effect);
                    conditionalStatement.Resource.push(curMethod.resource_arn);
                    conditionalStatement.Condition = curMethod.conditions;
                    statements.push(conditionalStatement);
                }
            });

            statements.push(statement);
        }
        return statements;
    }

    public allowAllMethods(): void {
        this.addMethod('Allow', HttpVerb.ALL, '*', []);
    }

    public denyAllMethods(): void {
        this.addMethod('Deny', HttpVerb.ALL, '*', []);
    }

    public allowMethod(verb: string, resource: string): void {
        this.addMethod('Allow', verb, resource, []);
    }

    public denyMethod(verb: string, resource: string): void {
        this.addMethod('Deny', verb, resource, []);
    }

    public allowMethodWithConditions(verb: string, resource: string, conditions: any): void {
        this.addMethod('Allow', verb, resource, conditions);
    }

    public denyMethodWithConditions(verb: string, resource: string, conditions: any): void {
        this.addMethod('Deny', verb, resource, conditions);
    }

    public build(): AuthResponse {
        if (this.allowMethods.length === 0 && this.denyMethods.length === 0) {
            throw new Error('No statements defined for the policy');
        }

        const policyDoc: PolicyDocument = {
            Version: this.version,
            Statement: [],
        };

        policyDoc.Statement = policyDoc.Statement.concat(this.get_statement_for_effect('Allow', this.allowMethods));
        policyDoc.Statement = policyDoc.Statement.concat(this.get_statement_for_effect('Deny', this.denyMethods));

        return {
            principalId: this.principalId,
            policyDocument: policyDoc,
        };
    }
}

const validate_token = async (token: string, region: string): Promise<any> => {
    const iss = `https://cognito-idp.${region}.amazonaws.com/${user_pool_id}`;
    const keys_url = `${iss}/.well-known/jwks.json`;

    if (is_cold_start) {
        try {
            const response = await axios.get(keys_url);
            const keys = response.data.keys;
            keys.forEach((key: any) => {
                const jwkArray = {
                    kty: key.kty,
                    n: key.n,
                    e: key.e,
                };
                pems[key.kid] = jwkToPem(jwkArray);
            });
        } catch (err) {
            console.error(err);
            throw new AxiosError(err as string);
        }
        is_cold_start = false;
    }
    const decodedJwt = jwt.decode(token, { complete: true });
    if (!decodedJwt) {
        throw new Error('Invalid JWT token');
    }

    // Fail if token is not from your UserPool
    if ((decodedJwt as { [key: string]: any }).payload.iss !== iss) {
        throw new Error('Invalid issuer');
    }

    // Reject the jwt if it's not an 'Access Token'
    if ((decodedJwt as { [key: string]: any }).payload.token_use !== 'access') {
        throw new Error('not an access token');
    }

    // Get the kid from the token and retrieve corresponding PEM
    const kid = (decodedJwt as { [key: string]: any }).header.kid;
    const pem = pems[kid];
    if (!pem) {
        throw new Error('invalid access token');
    }

    try {
        // Verify the signature of the JWT token to ensure it's really coming from your User Pool
        return jwt.verify(token, pem, { issuer: iss, audience: app_client_id });
    } catch (error) {
        console.error(error);
        throw new Error('Verification error');
    }
};

export const lambdaHandler = async (event: APIGatewayTokenAuthorizerEvent): Promise<AuthResponse> => {
    try {
        const tmp = event.methodArn.split(':');
        const api_gateway_arn_temp = tmp[5].split('/');
        const region = tmp[3];
        const aws_account_id = tmp[4];

        const authorizationToken = event.authorizationToken;
        let token: string;
        if (authorizationToken.startsWith('Bearer ')) {
            token = authorizationToken.substring(7);
        } else {
            throw new Error('Bearer is a recommendation in the RFC');
        }

        const validated_decoded_token = await validate_token(token, region);
        const principalId = validated_decoded_token.sub;
        const policy = new AuthPolicy(
            principalId,
            aws_account_id,
            api_gateway_arn_temp[0],
            region,
            api_gateway_arn_temp[1],
        );

        if (
            validated_decoded_token['cognito:groups'] &&
            validated_decoded_token['cognito:groups'].includes(admin_group_name)
        ) {
            policy.allowAllMethods();
        }

        const response = policy.build();
        console.log(JSON.stringify(response, null, 2));
        return response;
    } catch (err) {
        console.error('an error happened during authentication', err);
        throw new Error('Unauthorized');
    }
};